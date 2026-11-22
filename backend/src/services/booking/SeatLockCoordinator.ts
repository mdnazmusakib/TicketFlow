import type { Logger } from 'pino';
import { RedisKeys } from '../../infrastructure/redis/keys';
import type { Lock, LockManager } from '../../infrastructure/redis/LockManager';
import type { TtlStore } from '../../infrastructure/redis/TtlStore';

export type LockAttempt =
  | { status: 'ACQUIRED'; lock: Lock }
  | { status: 'CONTENDED' }
  /** Redis unreachable: continue on PostgreSQL alone (it stays the authority). */
  | { status: 'DEGRADED' };

/**
 * Redis seat locks used to reject obviously contended holds early and cheaply.
 * They are an optimisation: correctness comes from the PostgreSQL transaction
 * and the partial unique index, so every Redis failure path is safe.
 *
 * Lock values are the booking id, so a lock can always be traced to (and
 * released by) the booking that owns it.
 */
export class SeatLockCoordinator {
  constructor(
    private readonly locks: LockManager,
    private readonly store: TtlStore,
    private readonly options: {
      /** Short TTL while the DB transaction runs, so a crashed request frees seats quickly. */
      acquireTtlMs: number;
      logger?: Logger;
      /** Is this booking id still occupying seats? Used to reclaim stale locks. */
      isBookingActive: (bookingId: string) => Promise<boolean>;
    },
  ) {}

  keys(eventId: string, seatIds: string[]): string[] {
    return seatIds.map((seatId) => RedisKeys.seatHold(eventId, seatId));
  }

  async acquire(eventId: string, seatIds: string[], bookingId: string): Promise<LockAttempt> {
    const keys = this.keys(eventId, seatIds);
    try {
      const lock = await this.locks.acquire(keys, this.options.acquireTtlMs, bookingId);
      if (lock) return { status: 'ACQUIRED', lock };
      // Locks left by bookings that are no longer active (cancelled, expired,
      // confirmed then released) are reclaimed once, then acquisition retried.
      if (await this.reclaimStale(keys)) {
        const retry = await this.locks.acquire(keys, this.options.acquireTtlMs, bookingId);
        if (retry) return { status: 'ACQUIRED', lock: retry };
      }
      return { status: 'CONTENDED' };
    } catch (error) {
      this.options.logger?.warn(
        { err: error },
        'Redis seat locks unavailable; relying on PostgreSQL only',
      );
      return { status: 'DEGRADED' };
    }
  }

  /** After commit: keep the lock for the lifetime of the hold. */
  async extendToHold(lock: Lock, holdExpiresAt: Date): Promise<void> {
    const ttl = Math.max(1_000, holdExpiresAt.getTime() - Date.now());
    await this.safely(() => this.locks.extend(lock, ttl), 'extend');
  }

  /** Releases only keys still owned by this lock (compare-and-delete). */
  async release(lock: Lock): Promise<void> {
    await this.safely(() => this.locks.release(lock), 'release');
  }

  /** Releases the seat locks a booking owns, e.g. after expiry, cancellation or confirmation. */
  async releaseForBooking(eventId: string, seatIds: string[], bookingId: string): Promise<void> {
    if (seatIds.length === 0) return;
    await this.release({
      keys: this.keys(eventId, seatIds),
      token: bookingId,
      ttlMs: this.options.acquireTtlMs,
    });
  }

  private async reclaimStale(keys: string[]): Promise<boolean> {
    let reclaimed = false;
    for (const key of keys) {
      const owner = await this.store.get(key);
      if (owner && !(await this.options.isBookingActive(owner))) {
        reclaimed = (await this.store.compareAndDelete(key, owner)) || reclaimed;
      }
    }
    return reclaimed;
  }

  private async safely(work: () => Promise<unknown>, action: string): Promise<void> {
    try {
      await work();
    } catch (error) {
      // A missed release only delays a seat until the lock TTL; the DB is unaffected.
      this.options.logger?.warn({ err: error, action }, 'Redis seat lock operation failed');
    }
  }
}
