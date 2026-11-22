import type { Logger } from 'pino';

export interface ExpiryRunner {
  expireDue(): Promise<number>;
}

/**
 * Periodically releases expired seat holds.
 * - Runs once on start (catches holds that expired while the server was down).
 * - Never overlaps itself; errors are logged and retried on the next tick.
 * - Safe with several API instances: claiming uses FOR UPDATE SKIP LOCKED and
 *   every transition re-checks state, so a booking is expired exactly once.
 */
export class BookingExpiryWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly runner: ExpiryRunner,
    private readonly options: { intervalMs: number; logger?: Logger },
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
  }

  /** Runs one pass now (skipped if a pass is already in progress). */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runner
      .expireDue()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.options.logger?.error({ err: error }, 'Hold expiry pass failed; will retry');
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /** Stops scheduling and waits for an in-flight pass to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
