import { createHash } from 'node:crypto';
import type { IdempotencyRepository } from '../../repositories/IdempotencyRepository';
import { AppError } from '../../shared/errors/AppError';

export interface IdempotentResponse {
  status: number;
  body: unknown;
}

export interface IdempotencyScope {
  userId: string;
  /** Logical endpoint, e.g. "POST /api/bookings/:id/payments". */
  endpoint: string;
  key: string;
  /** Request content that must not change for the same key. */
  payload: unknown;
}

/** Stable JSON (sorted keys) so equal payloads always hash the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestHash(payload: unknown): string {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

/**
 * `Idempotency-Key + user + endpoint` semantics (ALGORITHMS §1.3):
 * - first request runs and its response is stored;
 * - a retry with the same payload gets the stored response (no re-execution);
 * - the same key with a different payload is rejected (422);
 * - a concurrent duplicate while the first is still running gets 409;
 * - a record abandoned by a crashed request can be taken over after its lock expires;
 * - failures release the key so the client can retry (domain records such as
 *   the payment row remain the anchor that prevents double charges).
 */
export class IdempotencyService {
  constructor(
    private readonly repository: IdempotencyRepository,
    private readonly options: { lockSeconds: number; retentionHours: number } = {
      lockSeconds: 60,
      retentionHours: 24,
    },
  ) {}

  async execute(
    scope: IdempotencyScope,
    work: () => Promise<IdempotentResponse>,
  ): Promise<IdempotentResponse & { replayed: boolean }> {
    const hash = requestHash(scope.payload);
    let id = await this.repository.tryInsert({
      userId: scope.userId,
      endpoint: scope.endpoint,
      key: scope.key,
      requestHash: hash,
      lockSeconds: this.options.lockSeconds,
      retentionHours: this.options.retentionHours,
    });

    if (!id) {
      const existing = await this.repository.find(scope.userId, scope.endpoint, scope.key);
      if (!existing)
        throw new AppError(
          409,
          'IDEMPOTENCY_IN_PROGRESS',
          'Request is being processed, retry shortly',
        );
      if (existing.requestHash !== hash) {
        throw new AppError(
          422,
          'IDEMPOTENCY_KEY_MISMATCH',
          'This Idempotency-Key was already used with a different request',
        );
      }
      if (existing.status === 'COMPLETED') {
        return {
          status: existing.responseStatus ?? 200,
          body: existing.responseBody,
          replayed: true,
        };
      }
      if (
        !existing.lockExpired ||
        !(await this.repository.takeOver(existing.id, this.options.lockSeconds))
      ) {
        throw new AppError(
          409,
          'IDEMPOTENCY_IN_PROGRESS',
          'An identical request is still being processed, retry shortly',
        );
      }
      id = existing.id;
    }

    try {
      const response = await work();
      await this.repository.complete(id, response.status, response.body);
      return { ...response, replayed: false };
    } catch (error) {
      await this.repository.release(id);
      throw error;
    }
  }
}
