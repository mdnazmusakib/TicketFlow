import { z } from 'zod';
import { BOOKING_STATUSES } from '../domain/lifecycle/bookingStateMachine';

const booleanQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

export const notificationListSchema = z.object({
  unreadOnly: booleanQuery,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const eventBookingsQuerySchema = z.object({
  status: z.enum(BOOKING_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const adminUsersQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : undefined)),
  role: z.enum(['CUSTOMER', 'ORGANIZER', 'ADMIN']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
