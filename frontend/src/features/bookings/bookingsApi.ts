import { apiClient, type ApiClient } from '../../lib/apiClient';
import type { PageMeta } from '../events/types';

export type BookingStatus = 'HELD' | 'PENDING_PAYMENT' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';

export interface QuoteLine {
  seatId: string;
  row: string;
  number: number;
  category: string;
  basePriceMinor: number;
  discountMinor: number;
  unitPriceMinor: number;
  available: boolean;
}

export interface Quote {
  currency: string;
  appliedStrategy: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  lines: QuoteLine[];
}

export type PaymentProvider = 'MOCK_PROVIDER_A' | 'MOCK_PROVIDER_B' | 'SSLCOMMERZ';
export type PaymentStatus = 'INITIATED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface Payment {
  id: string;
  bookingId: string;
  provider: PaymentProvider;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  transactionRef: string;
  redirectUrl: string | null;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface Refund {
  id: string;
  status: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  amountMinor: number;
  currency: string;
  attempt: number;
  reason: string | null;
  failureReason: string | null;
  processedAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
}

export interface RefundDecision {
  refundable: boolean;
  refundAmountMinor: number;
  hoursUntilEvent: number;
}

export interface CancellationPreview extends RefundDecision {
  bookingStatus: BookingStatus;
  paidAmountMinor: number;
  currency: string;
  cancellable: boolean;
}

export interface PaymentResult {
  payment: Payment;
  booking: Booking;
}

export interface Booking {
  id: string;
  status: BookingStatus;
  eventId: string;
  event: { title: string; startAt: string; venueName: string; venueCity: string; timezone: string };
  holdExpiresAt: string | null;
  pricingStrategy: string;
  totalAmountMinor: number;
  refundAmountMinor: number;
  currency: string;
  seats: {
    seatId: string;
    row: string;
    number: number;
    category: string;
    priceMinor: number;
    state: string;
  }[];
  history: { from: BookingStatus | null; to: BookingStatus; reason: string | null; at: string }[];
  confirmedAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  createdAt: string;
  serverTime: string;
  payments?: Payment[];
  refunds?: Refund[];
  refundDecision?: RefundDecision;
}

export interface BookingSummary {
  id: string;
  status: BookingStatus;
  eventId: string;
  event: Booking['event'];
  seatCount: number;
  totalAmountMinor: number;
  currency: string;
  holdExpiresAt: string | null;
  createdAt: string;
}

export function createBookingsApi(client: ApiClient = apiClient) {
  return {
    async quote(eventId: string, seatIds: string[], signal?: AbortSignal) {
      return (await client.post<Quote>('/bookings/quote', { eventId, seatIds }, { signal })).data;
    },
    /** The idempotency key makes a retried click return the same hold instead of a second one. */
    async hold(eventId: string, seatIds: string[], idempotencyKey: string) {
      return (
        await client.post<Booking>(
          '/bookings',
          { eventId, seatIds },
          { headers: { 'Idempotency-Key': idempotencyKey } },
        )
      ).data;
    },
    async list(
      params: { status?: BookingStatus; page?: number; pageSize?: number },
      signal?: AbortSignal,
    ) {
      const { data, meta } = await client.get<BookingSummary[]>('/bookings', {
        query: { ...params },
        signal,
      });
      return { items: data, meta: meta as unknown as PageMeta };
    },
    async get(id: string, signal?: AbortSignal) {
      return (await client.get<Booking>(`/bookings/${encodeURIComponent(id)}`, { signal })).data;
    },
    async checkout(id: string) {
      return (await client.post<Booking>(`/bookings/${encodeURIComponent(id)}/checkout`)).data;
    },
    async providers(signal?: AbortSignal) {
      return (
        await client.get<{ providers: PaymentProvider[]; mockProviderBTokens: string[] }>(
          '/payments/providers',
          { signal },
        )
      ).data;
    },
    async pay(
      bookingId: string,
      provider: PaymentProvider,
      idempotencyKey: string,
      paymentMethodToken?: string,
    ) {
      return (
        await client.post<PaymentResult>(
          `/bookings/${encodeURIComponent(bookingId)}/payments`,
          paymentMethodToken ? { provider, paymentMethodToken } : { provider },
          { headers: { 'Idempotency-Key': idempotencyKey } },
        )
      ).data;
    },
    async paymentStatus(paymentId: string, signal?: AbortSignal) {
      return (
        await client.get<PaymentResult>(`/payments/${encodeURIComponent(paymentId)}`, { signal })
      ).data;
    },
    async cancelPayment(paymentId: string) {
      return (await client.post<PaymentResult>(`/payments/${encodeURIComponent(paymentId)}/cancel`))
        .data;
    },
    async mockCheckout(transactionRef: string, signal?: AbortSignal) {
      return (
        await client.get<PaymentResult>(`/payments/mock/${encodeURIComponent(transactionRef)}`, {
          signal,
        })
      ).data;
    },
    async mockComplete(transactionRef: string, outcome: 'success' | 'failure') {
      return (
        await client.post<PaymentResult>('/payments/mock/complete', { transactionRef, outcome })
      ).data;
    },
    async cancellationPreview(id: string, signal?: AbortSignal) {
      return (
        await client.get<CancellationPreview>(`/bookings/${encodeURIComponent(id)}/cancellation`, {
          signal,
        })
      ).data;
    },
    async retryRefund(id: string) {
      return (await client.post<Booking>(`/bookings/${encodeURIComponent(id)}/refunds/retry`)).data;
    },
    async cancel(id: string, reason?: string) {
      return (
        await client.post<Booking>(
          `/bookings/${encodeURIComponent(id)}/cancel`,
          reason ? { reason } : {},
        )
      ).data;
    },
  };
}

export type BookingsApi = ReturnType<typeof createBookingsApi>;
export const bookingsApi = createBookingsApi();

export const PROVIDER_LABEL: Record<PaymentProvider, string> = {
  MOCK_PROVIDER_A: 'Card (hosted page) · Mock Provider A',
  MOCK_PROVIDER_B: 'Saved card · Mock Provider B',
  SSLCOMMERZ: 'SSLCommerz (cards, bKash, Nagad)',
};

export const TOKEN_LABEL: Record<string, string> = {
  tok_success: 'Card that succeeds',
  tok_decline: 'Card that is declined',
  tok_pending: 'Card that settles asynchronously',
  tok_timeout: 'Provider timeout after charging',
  tok_refund_fail_once: 'Card whose first refund fails',
};

export function newIdempotencyKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export const STATUS_LABEL: Record<BookingStatus, string> = {
  HELD: 'Seats held',
  PENDING_PAYMENT: 'Awaiting payment',
  CONFIRMED: 'Confirmed',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};
