import type { PaymentProviderName } from '../domain/payments/PaymentGateway';
import type { PaymentStatus, RefundStatus } from '../domain/payments/paymentRules';
import type { Queryable } from '../infrastructure/database/types';

export interface PaymentRecord {
  id: string;
  bookingId: string;
  provider: PaymentProviderName;
  providerPaymentId: string | null;
  transactionRef: string;
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
  idempotencyKey: string;
  failureReason: string | null;
  metadata: Record<string, unknown>;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefundRecord {
  id: string;
  bookingId: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  status: RefundStatus;
  attempt: number;
  idempotencyKey: string;
  providerRefundId: string | null;
  reason: string | null;
  failureReason: string | null;
  processedAt: Date | null;
  nextRetryAt: Date | null;
  createdAt: Date;
}

interface PaymentRow {
  id: string;
  booking_id: string;
  provider: PaymentProviderName;
  provider_payment_id: string | null;
  transaction_ref: string;
  amount_minor: string;
  currency: string;
  status: PaymentStatus;
  idempotency_key: string;
  failure_reason: string | null;
  provider_metadata: Record<string, unknown>;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface RefundRow {
  id: string;
  booking_id: string;
  payment_id: string;
  amount_minor: string;
  currency: string;
  status: RefundStatus;
  attempt: number;
  idempotency_key: string;
  provider_refund_id: string | null;
  reason: string | null;
  failure_reason: string | null;
  processed_at: Date | null;
  next_retry_at: Date | null;
  created_at: Date;
}

const toPayment = (row: PaymentRow): PaymentRecord => ({
  id: row.id,
  bookingId: row.booking_id,
  provider: row.provider,
  providerPaymentId: row.provider_payment_id,
  transactionRef: row.transaction_ref,
  amountMinor: Number(row.amount_minor),
  currency: row.currency,
  status: row.status,
  idempotencyKey: row.idempotency_key,
  failureReason: row.failure_reason,
  metadata: row.provider_metadata ?? {},
  paidAt: row.paid_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toRefund = (row: RefundRow): RefundRecord => ({
  id: row.id,
  bookingId: row.booking_id,
  paymentId: row.payment_id,
  amountMinor: Number(row.amount_minor),
  currency: row.currency,
  status: row.status,
  attempt: row.attempt,
  idempotencyKey: row.idempotency_key,
  providerRefundId: row.provider_refund_id,
  reason: row.reason,
  failureReason: row.failure_reason,
  processedAt: row.processed_at,
  nextRetryAt: row.next_retry_at,
  createdAt: row.created_at,
});

export interface NewPayment {
  id: string;
  bookingId: string;
  provider: PaymentProviderName;
  transactionRef: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
}

export interface PaymentUpdate {
  status: PaymentStatus;
  providerPaymentId?: string | null;
  failureReason?: string | null;
  metadata?: Record<string, unknown>;
}

export class PaymentRepository {
  constructor(private readonly db: Queryable) {}

  async create(tx: Queryable, payment: NewPayment): Promise<PaymentRecord> {
    const { rows } = await tx.query<PaymentRow>(
      `INSERT INTO payments (id, booking_id, provider, transaction_ref, amount_minor, currency, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        payment.id,
        payment.bookingId,
        payment.provider,
        payment.transactionRef,
        payment.amountMinor,
        payment.currency,
        payment.idempotencyKey,
      ],
    );
    return toPayment(rows[0]!);
  }

  async findById(
    id: string,
    db: Queryable = this.db,
    forUpdate = false,
  ): Promise<PaymentRecord | null> {
    const { rows } = await db.query<PaymentRow>(
      `SELECT * FROM payments WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async findByTransactionRef(
    ref: string,
    db: Queryable = this.db,
    forUpdate = false,
  ): Promise<PaymentRecord | null> {
    const { rows } = await db.query<PaymentRow>(
      `SELECT * FROM payments WHERE transaction_ref = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [ref],
    );
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async findByIdempotencyKey(key: string, db: Queryable = this.db): Promise<PaymentRecord | null> {
    const { rows } = await db.query<PaymentRow>(
      'SELECT * FROM payments WHERE idempotency_key = $1',
      [key],
    );
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async findOpenForBooking(
    bookingId: string,
    db: Queryable = this.db,
  ): Promise<PaymentRecord | null> {
    const { rows } = await db.query<PaymentRow>(
      `SELECT * FROM payments WHERE booking_id = $1 AND status IN ('INITIATED', 'PENDING')`,
      [bookingId],
    );
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async findSucceededForBooking(
    bookingId: string,
    db: Queryable = this.db,
  ): Promise<PaymentRecord | null> {
    const { rows } = await db.query<PaymentRow>(
      `SELECT * FROM payments WHERE booking_id = $1 AND status = 'SUCCEEDED'`,
      [bookingId],
    );
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async listForBooking(bookingId: string, db: Queryable = this.db): Promise<PaymentRecord[]> {
    const { rows } = await db.query<PaymentRow>(
      'SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at, id',
      [bookingId],
    );
    return rows.map(toPayment);
  }

  /** Writes a status change; metadata is merged, paid_at follows SUCCEEDED. */
  async update(tx: Queryable, id: string, update: PaymentUpdate): Promise<PaymentRecord> {
    const { rows } = await tx.query<PaymentRow>(
      `UPDATE payments SET
         status = $2::varchar,
         provider_payment_id = COALESCE($3, provider_payment_id),
         failure_reason = CASE WHEN $2::varchar = 'SUCCEEDED' THEN NULL ELSE COALESCE($4, failure_reason) END,
         provider_metadata = provider_metadata || $5::jsonb,
         paid_at = CASE WHEN $2::varchar = 'SUCCEEDED' THEN COALESCE(paid_at, now()) ELSE NULL END
       WHERE id = $1 RETURNING *`,
      [
        id,
        update.status,
        update.providerPaymentId ?? null,
        update.failureReason ?? null,
        JSON.stringify(update.metadata ?? {}),
      ],
    );
    return toPayment(rows[0]!);
  }

  /** Open attempts whose outcome should be re-checked with the provider. */
  async listOpenForReconciliation(
    olderThanSeconds: number,
    limit: number,
  ): Promise<PaymentRecord[]> {
    const { rows } = await this.db.query<PaymentRow>(
      `SELECT * FROM payments WHERE status IN ('INITIATED', 'PENDING')
         AND updated_at <= now() - make_interval(secs => $1)
       ORDER BY updated_at LIMIT $2`,
      [olderThanSeconds, limit],
    );
    return rows.map(toPayment);
  }

  // ------------------------------------------------------------- refunds

  async createRefund(
    tx: Queryable,
    refund: {
      bookingId: string;
      paymentId: string;
      amountMinor: number;
      currency: string;
      attempt: number;
      idempotencyKey: string;
      reason: string;
    },
  ): Promise<RefundRecord> {
    const { rows } = await tx.query<RefundRow>(
      `INSERT INTO refunds (booking_id, payment_id, amount_minor, currency, attempt, idempotency_key, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        refund.bookingId,
        refund.paymentId,
        refund.amountMinor,
        refund.currency,
        refund.attempt,
        refund.idempotencyKey,
        refund.reason,
      ],
    );
    return toRefund(rows[0]!);
  }

  async findRefund(
    id: string,
    db: Queryable = this.db,
    forUpdate = false,
  ): Promise<RefundRecord | null> {
    const { rows } = await db.query<RefundRow>(
      `SELECT * FROM refunds WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ? toRefund(rows[0]) : null;
  }

  async latestRefund(paymentId: string, db: Queryable = this.db): Promise<RefundRecord | null> {
    const { rows } = await db.query<RefundRow>(
      'SELECT * FROM refunds WHERE payment_id = $1 ORDER BY attempt DESC LIMIT 1',
      [paymentId],
    );
    return rows[0] ? toRefund(rows[0]) : null;
  }

  async refundsForBooking(bookingId: string, db: Queryable = this.db): Promise<RefundRecord[]> {
    const { rows } = await db.query<RefundRow>(
      'SELECT * FROM refunds WHERE booking_id = $1 ORDER BY created_at, attempt',
      [bookingId],
    );
    return rows.map(toRefund);
  }

  async updateRefund(
    tx: Queryable,
    id: string,
    update: {
      status: RefundStatus;
      providerRefundId?: string | null;
      failureReason?: string | null;
      nextRetryAt?: Date | null;
    },
  ): Promise<RefundRecord> {
    const { rows } = await tx.query<RefundRow>(
      `UPDATE refunds SET
         status = $2::varchar,
         provider_refund_id = COALESCE($3, provider_refund_id),
         failure_reason = CASE WHEN $2::varchar = 'SUCCEEDED' THEN NULL ELSE COALESCE($4, failure_reason) END,
         processed_at = CASE WHEN $2::varchar IN ('SUCCEEDED', 'FAILED') THEN now() ELSE NULL END,
         next_retry_at = $5
       WHERE id = $1 RETURNING *`,
      [
        id,
        update.status,
        update.providerRefundId ?? null,
        update.failureReason ?? null,
        update.nextRetryAt ?? null,
      ],
    );
    return toRefund(rows[0]!);
  }

  /**
   * Latest refund attempt per payment that still needs work: PENDING/PROCESSING
   * whose retry time has come, or FAILED with a scheduled retry.
   */
  async listDueRefunds(limit: number): Promise<RefundRecord[]> {
    const { rows } = await this.db.query<RefundRow>(
      `SELECT r.* FROM refunds r
       WHERE r.attempt = (SELECT max(attempt) FROM refunds x WHERE x.payment_id = r.payment_id)
         AND r.status IN ('PENDING', 'PROCESSING', 'FAILED')
         AND r.next_retry_at IS NOT NULL AND r.next_retry_at <= now()
       ORDER BY r.next_retry_at LIMIT $1`,
      [limit],
    );
    return rows.map(toRefund);
  }

  /** Caches the successfully refunded total on the booking (same transaction as the refund update). */
  async setBookingRefundAmount(
    tx: Queryable,
    bookingId: string,
    amountMinor: number,
  ): Promise<void> {
    // Only cancelled bookings carry a refund amount (chk_bookings_refund_only_when_cancelled);
    // refunds of late payments on expired holds live in the refunds table only.
    await tx.query(
      `UPDATE bookings SET refund_amount_minor = $2 WHERE id = $1 AND status = 'CANCELLED'`,
      [bookingId, amountMinor],
    );
  }

  // ------------------------------------------------------ webhook events

  /** Records an incoming webhook once; returns null for duplicate deliveries. */
  async insertWebhookEvent(event: {
    provider: PaymentProviderName;
    providerEventId: string;
    eventType: string;
    paymentId: string | null;
    signatureVerified: boolean;
    payload: Record<string, unknown>;
    status: 'PENDING' | 'REJECTED';
    error?: string;
  }): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO payment_webhook_events
         (provider, provider_event_id, event_type, payment_id, signature_verified, payload, processing_status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id`,
      [
        event.provider,
        event.providerEventId.slice(0, 255),
        event.eventType.slice(0, 100),
        event.paymentId,
        event.signatureVerified,
        JSON.stringify(event.payload),
        event.status,
        event.error ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  }

  async findWebhookEvent(
    provider: PaymentProviderName,
    providerEventId: string,
  ): Promise<{ id: string; processingStatus: string; signatureVerified: boolean } | null> {
    const { rows } = await this.db.query<{
      id: string;
      processing_status: string;
      signature_verified: boolean;
    }>(
      'SELECT id, processing_status, signature_verified FROM payment_webhook_events WHERE provider = $1 AND provider_event_id = $2',
      [provider, providerEventId.slice(0, 255)],
    );
    return rows[0]
      ? {
          id: rows[0].id,
          processingStatus: rows[0].processing_status,
          signatureVerified: rows[0].signature_verified,
        }
      : null;
  }

  /** Atomically claims a stored event for processing; false if another delivery already has it. */
  async claimWebhookEvent(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE payment_webhook_events SET processing_status = 'PROCESSING'
       WHERE id = $1 AND processing_status IN ('PENDING', 'FAILED')`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async markWebhookEvent(
    id: string,
    status: 'PROCESSING' | 'PROCESSED' | 'FAILED',
    error: string | null = null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE payment_webhook_events SET processing_status = $2::varchar, error_message = $3,
         processed_at = CASE WHEN $2::varchar IN ('PROCESSED', 'FAILED') THEN now() ELSE processed_at END
       WHERE id = $1`,
      [id, status, error],
    );
  }
}
