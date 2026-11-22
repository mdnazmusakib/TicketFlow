import { z } from 'zod';
import { PAYMENT_PROVIDERS } from '../domain/payments/PaymentGateway';

export const initiatePaymentSchema = z
  .object({
    provider: z.enum(PAYMENT_PROVIDERS),
    /** Tokenised payment method for direct-charge providers (never raw card data). */
    paymentMethodToken: z
      .string()
      .regex(/^tok_[a-z_]{1,40}$/, 'Invalid payment method token')
      .optional(),
  })
  .strict();

/** Idempotency-Key is mandatory for payment initiation. */
export const paymentIdempotencyKeySchema = z
  .string({ message: 'Idempotency-Key header is required' })
  .trim()
  .regex(/^[A-Za-z0-9_-]{8,128}$/, 'Idempotency-Key must be 8-128 chars of A-Z, a-z, 0-9, _ or -');

export const mockCompleteSchema = z
  .object({
    transactionRef: z.string().regex(/^[A-Za-z0-9_-]{8,30}$/),
    outcome: z.enum(['success', 'failure']),
  })
  .strict();

export const transactionRefParamsSchema = z.object({
  transactionRef: z.string().regex(/^[A-Za-z0-9_-]{8,30}$/),
});

export const providerParamsSchema = z.object({ provider: z.string().regex(/^[A-Za-z_]{3,30}$/) });

export const sslReturnParamsSchema = z.object({ result: z.enum(['success', 'fail', 'cancel']) });
