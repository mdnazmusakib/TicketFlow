import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { ValidationError, type ErrorDetail } from '../shared/errors/AppError';

export interface RequestSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

export interface ValidatedRequestData {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

function toDetails(part: string, error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: [part, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
}

/**
 * Validates body/query/params with Zod. Parsed (coerced, stripped) values are
 * exposed on `req.validated`; the parsed body also replaces `req.body` so
 * unknown fields never reach controllers. All parts are checked so the client
 * receives every problem at once.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, _res, next) => {
    const details: ErrorDetail[] = [];
    const validated: ValidatedRequestData = {};

    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        validated[part] = result.data;
      } else {
        details.push(...toDetails(part, result.error));
      }
    }

    if (details.length > 0) {
      next(new ValidationError(details));
      return;
    }

    if (schemas.body) req.body = validated.body;
    req.validated = validated;
    next();
  };
}

/** Typed accessor for controllers: `const { body } = getValidated<typeof schema>(req)`. */
export function getValidated<T extends ValidatedRequestData>(req: {
  validated?: ValidatedRequestData;
}): T {
  if (!req.validated) {
    throw new Error('validate() middleware must run before getValidated()');
  }
  return req.validated as T;
}
