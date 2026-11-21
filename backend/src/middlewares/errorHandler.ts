import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { InvalidTransitionError } from '../domain/lifecycle/bookingStateMachine';
import { mapPgError } from '../infrastructure/database/pgErrors';
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../shared/errors/AppError';
import type { ApiErrorBody } from '../shared/http/apiResponse';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
};

interface BodyParserError {
  type: string;
  status?: number;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return typeof error === 'object' && error !== null && 'type' in error && typeof error.type === 'string';
}

function normalize(error: unknown): AppError | undefined {
  if (error instanceof AppError) return error;
  if (error instanceof InvalidTransitionError) {
    return new ConflictError(error.message, 'INVALID_STATE_TRANSITION');
  }
  if (error instanceof ZodError) {
    return new ValidationError(
      error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
    );
  }
  if (isBodyParserError(error)) {
    if (error.type === 'entity.parse.failed') return new BadRequestError('Malformed JSON body', 'INVALID_JSON');
    if (error.type === 'entity.too.large') return new PayloadTooLargeError();
    if (error.status && error.status >= 400 && error.status < 500) return new BadRequestError();
  }
  return mapPgError(error);
}

/**
 * Central error handler: one response shape for every failure.
 * Unknown errors become a generic 500; internal messages and stacks are never
 * exposed outside development.
 */
export function createErrorHandler(logger: Logger, options: { exposeStack: boolean }): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const appError = normalize(error);
    const statusCode = appError?.statusCode ?? 500;
    const logContext = { err: error, requestId: String(req.id), method: req.method, path: req.path, statusCode };

    if (statusCode >= 500) logger.error(logContext, 'Request failed');
    else logger.warn({ ...logContext, err: undefined, code: appError?.code }, appError?.message);

    const body: ApiErrorBody = {
      success: false,
      error: {
        code: appError?.code ?? 'INTERNAL_ERROR',
        message: appError && !appError.isServerError ? appError.message : 'An unexpected error occurred',
        ...(appError?.details ? { details: appError.details } : {}),
        requestId: String(req.id),
        ...(options.exposeStack && error instanceof Error && error.stack ? { stack: error.stack } : {}),
      },
    };

    if (appError?.code === 'SERVICE_UNAVAILABLE') {
      body.error.message = appError.message;
    }

    res.status(statusCode).json(body);
  };
}
