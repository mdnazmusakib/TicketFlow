import { type AppError, ConflictError, ValidationError } from '../../shared/errors/AppError';

interface PgError {
  code: string;
  constraint?: string;
  detail?: string;
}

function isPgError(error: unknown): error is PgError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((error as { code: string }).code)
  );
}

/**
 * Maps constraint violations to safe client errors. Constraint names are
 * returned (they are part of the documented schema); raw SQL details are not.
 */
export function mapPgError(error: unknown): AppError | undefined {
  if (!isPgError(error)) return undefined;
  const constraint = error.constraint ?? 'unknown';
  switch (error.code) {
    case '23505':
      return new ConflictError(`Duplicate value violates ${constraint}`, 'CONFLICT', {
        cause: error,
      });
    case '23503':
      return new ConflictError(`Referenced record constraint ${constraint} failed`, 'CONFLICT', {
        cause: error,
      });
    case '23514':
    case '23502':
    case '22P02':
      return new ValidationError([{ path: constraint, message: 'Value violates a database rule' }]);
    case '23P01':
      return new ConflictError(`Exclusion constraint ${constraint} failed`, 'CONFLICT', {
        cause: error,
      });
    default:
      return undefined;
  }
}
