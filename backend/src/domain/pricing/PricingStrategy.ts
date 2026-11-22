/**
 * Pricing engine (Strategy pattern). All amounts are integer minor units and
 * every calculation happens on the server; client-sent prices are never used.
 */
export interface PricingContext {
  /** Catalogue price of the seat category, minor units. */
  basePriceMinor: number;
  /** Instant the price is computed for (hold time). */
  now: Date;
  /** Strategy parameters stored on the event. */
  event: {
    earlyBirdDeadline: Date | null;
    earlyBirdDiscountPct: number | null;
  };
}

export interface PriceResult {
  unitPriceMinor: number;
  discountMinor: number;
  /** Strategy that actually produced the price (EARLY_BIRD falls back to BASE after its deadline). */
  appliedStrategy: string;
}

/** One pricing rule. Implementations must be pure and interchangeable (LSP). */
export interface PricingStrategy {
  readonly name: string;
  price(context: PricingContext): PriceResult;
}

function assertMinor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Prices must be non-negative integer minor units');
  }
}

export class BasePriceStrategy implements PricingStrategy {
  readonly name = 'BASE';

  price({ basePriceMinor }: PricingContext): PriceResult {
    assertMinor(basePriceMinor);
    return { unitPriceMinor: basePriceMinor, discountMinor: 0, appliedStrategy: this.name };
  }
}

/**
 * Percentage discount until the deadline (exclusive). The discount is rounded
 * half-up to whole minor units using integer arithmetic only.
 */
export class EarlyBirdStrategy implements PricingStrategy {
  readonly name = 'EARLY_BIRD';
  private readonly fallback = new BasePriceStrategy();

  price(context: PricingContext): PriceResult {
    const { basePriceMinor, now, event } = context;
    assertMinor(basePriceMinor);
    const { earlyBirdDeadline: deadline, earlyBirdDiscountPct: pct } = event;
    if (!deadline || pct === null || now.getTime() >= deadline.getTime())
      return this.fallback.price(context);
    if (!Number.isInteger(pct) || pct < 1 || pct > 99)
      throw new Error('Early-bird discount must be 1-99%');

    const discountMinor = Math.floor((basePriceMinor * pct + 50) / 100);
    return {
      unitPriceMinor: basePriceMinor - discountMinor,
      discountMinor,
      appliedStrategy: this.name,
    };
  }
}

/**
 * Strategy lookup by the name stored on the event. New strategies are added by
 * registering them here (OCP): booking code never changes.
 */
export class PricingStrategyRegistry {
  private readonly strategies = new Map<string, PricingStrategy>();

  constructor(strategies: PricingStrategy[] = [new BasePriceStrategy(), new EarlyBirdStrategy()]) {
    for (const strategy of strategies) this.register(strategy);
  }

  register(strategy: PricingStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  resolve(name: string): PricingStrategy {
    const strategy = this.strategies.get(name);
    if (!strategy) throw new Error(`Unknown pricing strategy "${name}"`);
    return strategy;
  }
}
