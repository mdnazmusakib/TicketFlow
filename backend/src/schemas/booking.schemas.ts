import { z } from 'zod';
import { BOOKING_STATUSES } from '../domain/lifecycle/bookingStateMachine';

export const seatSelectionSchema = z
  .object({
    eventId: z.uuid(),
    seatIds: z.array(z.uuid()).min(1, 'Select at least one seat').max(50),
  })
  .strict();

export const cancelBookingSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict()
  .default({});

export const bookingListSchema = z.object({
  status: z.enum(BOOKING_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** Optional Idempotency-Key header for hold creation (safe client retries). */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{8,128}$/, 'Idempotency-Key must be 8-128 chars of A-Z, a-z, 0-9, _ or -');
