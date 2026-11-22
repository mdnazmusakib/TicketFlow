import type { Logger } from 'pino';

/**
 * Runs a task on an interval: once at start, never overlapping itself,
 * logging failures and retrying on the next tick. Safe to run on several
 * instances when the task claims its work with row locks (SKIP LOCKED).
 */
export class IntervalWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly task: () => Promise<unknown>,
    private readonly options: { intervalMs: number; name: string; logger?: Logger },
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.task()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.options.logger?.error(
          { err: error, worker: this.options.name },
          'Worker pass failed; will retry',
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
