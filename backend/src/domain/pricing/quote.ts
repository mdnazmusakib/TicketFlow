import { computeCharges, type ChargePolicy, type Charges } from './charges';
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
  /** Catalogue prices before any discount. */
  subtotalMinor: number;
  discountMinor: number;
  /** Ticket price total after discounts (= subtotalMinor - discountMinor). */
  ticketTotalMinor: number;
  /** Platform fee, VAT and grand total for this selection. */
  charges: Charges;
  /** Grand total the customer pays (= charges.grandTotalMinor). */
  totalMinor: number;
}

export const NO_CHARGES: ChargePolicy = { platformFeePerSeatMinor: 0, vatRateBps: 0 };

/** Prices a set of seats with the event's strategy at a given instant. */
export function buildQuote(
  registry: PricingStrategyRegistry,
  event: QuoteEvent,
  seats: QuoteSeat[],
  now: Date,
  chargePolicy: ChargePolicy = NO_CHARGES,
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
  const ticketTotalMinor = subtotalMinor - discountMinor;
  if (!Number.isSafeInteger(ticketTotalMinor))
    throw new Error('Total exceeds the safe integer range');
  const charges = computeCharges(ticketTotalMinor, lines.length, chargePolicy);
  return {
    currency: event.currency,
    appliedStrategy: applied,
    lines,
    subtotalMinor,
    discountMinor,
    ticketTotalMinor,
    charges,
    totalMinor: charges.grandTotalMinor,
  };
}
