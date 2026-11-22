import type { PricingStrategyRegistry } from './PricingStrategy';

export interface QuoteSeat {
  seatId: string;
  rowLabel: string;
  seatNumber: number;
  categoryId: string;
  categoryName: string;
  basePriceMinor: number;
}

export interface QuoteEvent {
  pricingStrategy: string;
  earlyBirdDeadline: Date | null;
  earlyBirdDiscountPct: number | null;
  currency: string;
}

export interface QuoteLine extends QuoteSeat {
  unitPriceMinor: number;
  discountMinor: number;
}

export interface Quote {
  currency: string;
  appliedStrategy: string;
  lines: QuoteLine[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
}

/** Prices a set of seats with the event's strategy at a given instant. */
export function buildQuote(
  registry: PricingStrategyRegistry,
  event: QuoteEvent,
  seats: QuoteSeat[],
  now: Date,
): Quote {
  const strategy = registry.resolve(event.pricingStrategy);
  let applied = 'BASE';
  const lines = seats.map((seat) => {
    const result = strategy.price({
      basePriceMinor: seat.basePriceMinor,
      now,
      event: {
        earlyBirdDeadline: event.earlyBirdDeadline,
        earlyBirdDiscountPct: event.earlyBirdDiscountPct,
      },
    });
    if (result.appliedStrategy !== 'BASE') applied = result.appliedStrategy;
    return { ...seat, unitPriceMinor: result.unitPriceMinor, discountMinor: result.discountMinor };
  });
  const subtotalMinor = lines.reduce((sum, line) => sum + line.basePriceMinor, 0);
  const discountMinor = lines.reduce((sum, line) => sum + line.discountMinor, 0);
  const totalMinor = subtotalMinor - discountMinor;
  if (!Number.isSafeInteger(totalMinor)) throw new Error('Total exceeds the safe integer range');
  return {
    currency: event.currency,
    appliedStrategy: applied,
    lines,
    subtotalMinor,
    discountMinor,
    totalMinor,
  };
}
