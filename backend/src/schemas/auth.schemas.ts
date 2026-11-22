import { z } from 'zod';
import { SELF_REGISTRATION_ROLES } from '../domain/auth/roles';

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email('Enter a valid email address'))
  .transform((value) => value.toLowerCase());

/** bcrypt only uses the first 72 bytes, so longer passwords are rejected rather than silently truncated. */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 bytes')
  .refine((value) => /[a-z]/.test(value), 'Password needs a lowercase letter')
  .refine((value) => /[A-Z]/.test(value), 'Password needs an uppercase letter')
  .refine((value) => /\d/.test(value), 'Password needs a digit')
  .refine((value) => /[^A-Za-z0-9]/.test(value), 'Password needs a symbol');

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(120),
    email: emailSchema,
    password: passwordSchema,
    role: z.enum(SELF_REGISTRATION_ROLES).default('CUSTOMER'),
  })
  .strict();

export const verifyOtpSchema = z
  .object({
    email: emailSchema,
    otp: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  })
  .strict();

export const resendOtpSchema = z.object({ email: emailSchema }).strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    // No policy check on login: just bounded input.
    password: z.string().min(1, 'Password is required').max(200),
  })
  .strict();
