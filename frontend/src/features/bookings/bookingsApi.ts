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

export const STATUS_LABEL: Record<BookingStatus, string> = {
  HELD: 'Seats held',
  PENDING_PAYMENT: 'Awaiting payment',
  CONFIRMED: 'Confirmed',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};
