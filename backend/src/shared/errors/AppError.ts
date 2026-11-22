export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'BAD_REQUEST'
  | 'INVALID_JSON'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNAUTHORIZED'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_NOT_VERIFIED'
  | 'EMAIL_TAKEN'
  | 'OTP_INVALID'
  | 'OTP_EXPIRED'
  | 'OTP_ATTEMPTS_EXCEEDED'
  | 'OTP_COOLDOWN'
  | 'ACCOUNT_DISABLED'
  | 'FORBIDDEN'
  | 'CORS_ORIGIN_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE_TRANSITION'
  | 'ACTIVE_BOOKINGS_EXIST'
  | 'SEATS_UNAVAILABLE'
  | 'TICKET_LIMIT_EXCEEDED'
  | 'HOLD_EXPIRED'
  | 'EVENT_NOT_ON_SALE'
  | 'IDEMPOTENCY_KEY_MISMATCH'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'PAYMENT_IN_PROGRESS'
  | 'PAYMENT_PROVIDER_UNAVAILABLE'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'RESOURCE_IN_USE'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * Base class for errors that are safe to show to API clients.
 * Anything that is not an AppError is treated as an unexpected 500.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: ErrorDetail[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }

  get isServerError(): boolean {
    return this.statusCode >= 500;
  }
}

export class ValidationError extends AppError {
  constructor(details: ErrorDetail[], message = 'Request validation failed') {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', code: 'BAD_REQUEST' | 'INVALID_JSON' = 'BAD_REQUEST') {
    super(400, code, message);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Request payload is too large') {
    super(413, 'PAYLOAD_TOO_LARGE', message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action',
    code: 'FORBIDDEN' | 'CORS_ORIGIN_DENIED' = 'FORBIDDEN',
  ) {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(
    message = 'Resource conflict',
    code: 'CONFLICT' | 'INVALID_STATE_TRANSITION' = 'CONFLICT',
    options?: { cause?: unknown },
  ) {
    super(409, code, message, undefined, options);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests, please try again later') {
    super(429, 'RATE_LIMITED', message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', options?: { cause?: unknown }) {
    super(503, 'SERVICE_UNAVAILABLE', message, undefined, options);
  }
}
