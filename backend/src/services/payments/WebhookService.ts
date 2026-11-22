import type { Logger } from 'pino';
import {
  PAYMENT_PROVIDERS,
  type PaymentGatewayRegistry,
  type PaymentProviderName,
  type WebhookRequest,
} from '../../domain/payments/PaymentGateway';
import type { PaymentRepository } from '../../repositories/PaymentRepository';
import { AppError, NotFoundError } from '../../shared/errors/AppError';
import type { PaymentService } from './PaymentService';

export interface WebhookOutcome {
  status: 'processed' | 'duplicate' | 'ignored';
  paymentId: string | null;
}

/**
 * Provider callbacks (webhooks / IPN):
 * 1. signature/hash verified by the provider adapter (invalid -> stored as REJECTED, 401);
 * 2. stored once per (provider, event id) — duplicate deliveries are acknowledged, not re-applied;
 * 3. the payment is re-verified with the provider's API; the webhook body itself
 *    is never trusted for the payment status;
 * 4. booking/payment changes happen in one transaction (PaymentService.applyVerification).
 */
export class WebhookService {
  constructor(
    private readonly gateways: PaymentGatewayRegistry,
    private readonly payments: PaymentRepository,
    private readonly paymentService: PaymentService,
    private readonly logger?: Logger,
  ) {}

  async handle(providerParam: string, request: WebhookRequest): Promise<WebhookOutcome> {
    const provider = providerParam.toUpperCase() as PaymentProviderName;
    if (
      !(PAYMENT_PROVIDERS as readonly string[]).includes(provider) ||
      !this.gateways.has(provider)
    ) {
      throw new NotFoundError('Unknown payment provider');
    }
    const parsed = this.gateways.get(provider).parseWebhook(request);
    const payment = parsed.transactionRef
      ? await this.payments.findByTransactionRef(parsed.transactionRef)
      : null;

    if (!parsed.signatureValid) {
      await this.payments.insertWebhookEvent({
        provider,
        providerEventId: `rejected:${parsed.eventId}:${Date.now()}`,
        eventType: parsed.eventType,
        paymentId: payment?.id ?? null,
        signatureVerified: false,
        payload: parsed.safePayload,
        status: 'REJECTED',
        error: 'Invalid signature',
      });
      this.logger?.warn(
        { provider, eventId: parsed.eventId },
        'Rejected webhook with invalid signature',
      );
      throw new AppError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook signature');
    }

    let eventRowId = await this.payments.insertWebhookEvent({
      provider,
      providerEventId: parsed.eventId,
      eventType: parsed.eventType,
      paymentId: payment?.id ?? null,
      signatureVerified: true,
      payload: parsed.safePayload,
      status: 'PENDING',
    });
    if (!eventRowId) {
      const existing = await this.payments.findWebhookEvent(provider, parsed.eventId);
      if (
        !existing ||
        existing.processingStatus === 'PROCESSED' ||
        existing.processingStatus === 'PROCESSING'
      ) {
        return { status: 'duplicate', paymentId: payment?.id ?? null };
      }
      eventRowId = existing.id; // an earlier delivery failed mid-way: process again
    }

    // Claim the event so concurrent duplicate deliveries do not process it twice.
    const claimed = await this.claim(eventRowId);
    if (!claimed) return { status: 'duplicate', paymentId: payment?.id ?? null };

    if (!payment) {
      await this.payments.markWebhookEvent(
        eventRowId,
        'PROCESSED',
        'Unknown transaction reference',
      );
      return { status: 'ignored', paymentId: null };
    }

    try {
      await this.paymentService.verifyAndApply(payment.id, parsed.providerPaymentId);
      await this.payments.markWebhookEvent(eventRowId, 'PROCESSED');
      return { status: 'processed', paymentId: payment.id };
    } catch (error) {
      await this.payments.markWebhookEvent(
        eventRowId,
        'FAILED',
        (error as Error).message.slice(0, 500),
      );
      throw error;
    }
  }

  private async claim(eventRowId: string): Promise<boolean> {
    return this.payments.claimWebhookEvent(eventRowId);
  }
}
