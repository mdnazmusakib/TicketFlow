import { z } from 'zod';
import { parseDateBoundary } from './event.schemas';
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

const financeDate = (endOfDay: boolean) =>
  z
    .string()
    .trim()
    .max(40)
    .transform((value, ctx) => {
      const parsed = parseDateBoundary(value, endOfDay);
      if (!parsed) {
        ctx.addIssue({ code: 'custom', message: 'Invalid date: use YYYY-MM-DD' });
        return z.NEVER;
      }
      return parsed;
    });

/** Admin finance report period: from/to are inclusive calendar days (UTC). */
export const financeQuerySchema = z
  .object({ from: financeDate(false).optional(), to: financeDate(true).optional() })
  .refine((v) => !v.from || !v.to || v.from < v.to, {
    message: '"from" must not be after "to"',
    path: ['to'],
  });
