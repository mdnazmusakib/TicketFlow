import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import {
  BasePriceStrategy,
  EarlyBirdStrategy,
  PricingStrategyRegistry,
  type PricingStrategy,
} from '../../../src/domain/pricing/PricingStrategy';
import { buildQuote } from '../../../src/domain/pricing/quote';
import { RedisLockManager } from '../../../src/infrastructure/redis/LockManager';
import { RedisTtlStore } from '../../../src/infrastructure/redis/TtlStore';
import { SeatLockCoordinator } from '../../../src/services/booking/SeatLockCoordinator';
import { BookingExpiryWorker } from '../../../src/workers/BookingExpiryWorker';

const now = new Date('2026-12-01T00:00:00Z');
const later = new Date('2026-12-10T00:00:00Z');
const noEarlyBird = { earlyBirdDeadline: null, earlyBirdDiscountPct: null };

describe('pricing strategies', () => {
  it('BasePriceStrategy returns the catalogue price', () => {
    expect(
      new BasePriceStrategy().price({ basePriceMinor: 150000, now, event: noEarlyBird }),
    ).toEqual({
      unitPriceMinor: 150000,
      discountMinor: 0,
      appliedStrategy: 'BASE',
    });
  });

  it('EarlyBirdStrategy discounts before the deadline with integer half-up rounding', () => {
    const strategy = new EarlyBirdStrategy();
    const event = { earlyBirdDeadline: later, earlyBirdDiscountPct: 15 };
    expect(strategy.price({ basePriceMinor: 100000, now, event })).toEqual({
      unitPriceMinor: 85000,
      discountMinor: 15000,
      appliedStrategy: 'EARLY_BIRD',
    });
    // 333 * 15% = 49.95 -> 50 (half-up), never fractional minor units.
    expect(strategy.price({ basePriceMinor: 333, now, event })).toMatchObject({
      unitPriceMinor: 283,
      discountMinor: 50,
    });
    expect(strategy.price({ basePriceMinor: 0, now, event })).toMatchObject({ unitPriceMinor: 0 });
  });

  it('EarlyBirdStrategy falls back to base at/after the deadline or without config', () => {
    const strategy = new EarlyBirdStrategy();
    expect(
      strategy.price({
        basePriceMinor: 1000,
        now: later,
        event: { earlyBirdDeadline: later, earlyBirdDiscountPct: 20 },
      }),
    ).toMatchObject({
      unitPriceMinor: 1000,
      appliedStrategy: 'BASE',
    });
    expect(strategy.price({ basePriceMinor: 1000, now, event: noEarlyBird })).toMatchObject({
      appliedStrategy: 'BASE',
    });
  });

  it('rejects invalid inputs', () => {
    expect(() =>
      new BasePriceStrategy().price({ basePriceMinor: 10.5, now, event: noEarlyBird }),
    ).toThrow('integer minor units');
    expect(() =>
      new BasePriceStrategy().price({ basePriceMinor: -1, now, event: noEarlyBird }),
    ).toThrow();
    expect(() =>
      new EarlyBirdStrategy().price({
        basePriceMinor: 100,
        now,
        event: { earlyBirdDeadline: later, earlyBirdDiscountPct: 150 },
      }),
    ).toThrow('1-99%');
  });

  it('registry resolves strategies and accepts new ones without touching booking code', () => {
    const registry = new PricingStrategyRegistry();
    expect(registry.resolve('BASE')).toBeInstanceOf(BasePriceStrategy);
    expect(registry.resolve('EARLY_BIRD')).toBeInstanceOf(EarlyBirdStrategy);
    expect(() => registry.resolve('FLASH_SALE')).toThrow('Unknown pricing strategy');

    const flat: PricingStrategy = {
      name: 'FLAT_100',
      price: ({ basePriceMinor }) => ({
        unitPriceMinor: Math.max(0, basePriceMinor - 100),
        discountMinor: Math.min(100, basePriceMinor),
        appliedStrategy: 'FLAT_100',
      }),
    };
    registry.register(flat);
    const quote = buildQuote(
      registry,
      { pricingStrategy: 'FLAT_100', currency: 'BDT', ...noEarlyBird },
      [
        {
          seatId: 's',
          rowLabel: 'A',
          seatNumber: 1,
          categoryId: 'c',
          categoryName: 'G',
          basePriceMinor: 500,
        },
      ],
      now,
    );
    expect(quote).toMatchObject({
      appliedStrategy: 'FLAT_100',
      totalMinor: 400,
      discountMinor: 100,
    });
  });

  it('buildQuote sums lines exactly', () => {
    const seat = (id: string, price: number) => ({
      seatId: id,
      rowLabel: 'A',
      seatNumber: 1,
      categoryId: 'c',
      categoryName: 'G',
      basePriceMinor: price,
    });
    const quote = buildQuote(
      new PricingStrategyRegistry(),
      {
        pricingStrategy: 'EARLY_BIRD',
        currency: 'BDT',
        earlyBirdDeadline: later,
        earlyBirdDiscountPct: 10,
      },
      [seat('a', 200000), seat('b', 100001)],
      now,
    );
    expect(quote).toMatchObject({
      subtotalMinor: 300001,
      discountMinor: 30000,
      totalMinor: 270001,
      appliedStrategy: 'EARLY_BIRD',
    });
    expect(quote.lines.map((l) => l.unitPriceMinor)).toEqual([180000, 90001]);
  });
});

describe('SeatLockCoordinator', () => {
  let counter = 0;
  function setup(isBookingActive: (id: string) => Promise<boolean> = async () => true) {
    counter += 1;
    const prefix = `slc${process.pid}x${counter}:`;
    const redis = new RedisMock({ keyPrefix: prefix }) as unknown as Redis;
    const coordinator = new SeatLockCoordinator(
      new RedisLockManager(redis),
      new RedisTtlStore(redis, prefix),
      {
        acquireTtlMs: 15_000,
        isBookingActive,
      },
    );
    return { redis, coordinator };
  }

  it('acquires with the booking id as owner, extends to the hold and releases', async () => {
    const { redis, coordinator } = setup();
    const attempt = await coordinator.acquire('e1', ['s1', 's2'], 'booking-1');
    expect(attempt.status).toBe('ACQUIRED');
    expect(await redis.get('seat_hold:e1:s1')).toBe('booking-1');
    if (attempt.status !== 'ACQUIRED') return;
    await coordinator.extendToHold(attempt.lock, new Date(Date.now() + 300_000));
    expect(await redis.pttl('seat_hold:e1:s1')).toBeGreaterThan(200_000);
    await coordinator.releaseForBooking('e1', ['s1', 's2'], 'booking-1');
    expect(await redis.exists('seat_hold:e1:s1')).toBe(0);
    await coordinator.releaseForBooking('e1', [], 'booking-1');
  });

  it('reports contention, and reclaims locks whose owner is no longer active', async () => {
    const active = new Set(['owner-a']);
    const { coordinator } = setup(async (id) => active.has(id));
    await coordinator.acquire('e1', ['s1'], 'owner-a');
    expect((await coordinator.acquire('e1', ['s1'], 'owner-b')).status).toBe('CONTENDED');
    active.delete('owner-a');
    expect((await coordinator.acquire('e1', ['s1'], 'owner-b')).status).toBe('ACQUIRED');
  });

  it('degrades to PostgreSQL-only when Redis fails, and never throws on cleanup', async () => {
    const broken = {
      acquire: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      release: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      extend: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      withLock: jest.fn(),
    };
    const coordinator = new SeatLockCoordinator(broken, {} as never, {
      acquireTtlMs: 1000,
      isBookingActive: async () => true,
    });
    expect(await coordinator.acquire('e', ['s'], 'b')).toEqual({ status: 'DEGRADED' });
    const lock = { keys: ['k'], token: 'b', ttlMs: 1000 };
    await expect(coordinator.release(lock)).resolves.toBeUndefined();
    await expect(coordinator.extendToHold(lock, new Date())).resolves.toBeUndefined();
  });
});

describe('BookingExpiryWorker', () => {
  it('runs on start, never overlaps, survives failures and stops cleanly', async () => {
    let resolveRun: () => void = () => undefined;
    const runner = {
      expireDue: jest
        .fn()
        .mockImplementationOnce(
          () => new Promise<number>((resolve) => (resolveRun = () => resolve(1))),
        )
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValue(0),
    };
    const logger = { error: jest.fn() };
    const worker = new BookingExpiryWorker(runner, { intervalMs: 60_000, logger: logger as never });
    worker.start();
    worker.start(); // idempotent
    void worker.tick(); // overlapping tick joins the in-flight pass
    expect(runner.expireDue).toHaveBeenCalledTimes(1);
    resolveRun();
    await worker.tick();
    await worker.tick();
    expect(logger.error).toHaveBeenCalledWith(
      expect.anything(),
      'Hold expiry pass failed; will retry',
    );
    await worker.stop();
    expect(runner.expireDue.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
