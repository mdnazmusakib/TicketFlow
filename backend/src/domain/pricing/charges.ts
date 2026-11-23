/**
 * Customer charges on top of the ticket price (integer minor units only, never floats):
 *
 *   ticketSubtotal = sum of the seats' ticket prices (after any pricing-strategy discount)
 *   platformFee    = platformFeePerSeat × seatCount            (TicketFlow revenue)
 *   vat            = round_half_up(ticketSubtotal × vatRate)    (tax liability, not revenue)
 *   grandTotal     = ticketSubtotal + platformFee + vat         (what the customer pays)
 *
 * The VAT rate is a configurable business setting in basis points (200 = 2%); it is not a
 * statement about the legally applicable rate for any event category.
 */
export interface ChargePolicy {
  /** Platform charge per seat, minor units (BDT 10 = 1000 paisa). */
  platformFeePerSeatMinor: number;
  /** VAT rate in basis points (2% = 200). */
  vatRateBps: number;
}

export interface Charges {
  seatCount: number;
  ticketSubtotalMinor: number;
  platformFeePerSeatMinor: number;
  platformFeeMinor: number;
  vatRateBps: number;
  vatMinor: number;
  grandTotalMinor: number;
}

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

export function assertChargePolicy(policy: ChargePolicy): void {
  assertNonNegativeInt(policy.platformFeePerSeatMinor, 'Platform fee per seat');
  assertNonNegativeInt(policy.vatRateBps, 'VAT rate');
  if (policy.vatRateBps > 10_000) throw new Error('VAT rate must be at most 100%');
}

/** VAT on an amount, rounded half-up to whole minor units with integer arithmetic. */
export function vatOf(amountMinor: number, vatRateBps: number): number {
  assertNonNegativeInt(amountMinor, 'Amount');
  const product = amountMinor * vatRateBps;
  if (!Number.isSafeInteger(product)) throw new Error('Amount too large for VAT calculation');
  return Math.floor((product + 5_000) / 10_000);
}

export function computeCharges(
  ticketSubtotalMinor: number,
  seatCount: number,
  policy: ChargePolicy,
): Charges {
  assertNonNegativeInt(ticketSubtotalMinor, 'Ticket subtotal');
  if (!Number.isSafeInteger(seatCount) || seatCount < 1) {
    throw new Error('Seat count must be a positive integer');
  }
  assertChargePolicy(policy);
  const platformFeeMinor = policy.platformFeePerSeatMinor * seatCount;
  const vatMinor = vatOf(ticketSubtotalMinor, policy.vatRateBps);
  const grandTotalMinor = ticketSubtotalMinor + platformFeeMinor + vatMinor;
  if (!Number.isSafeInteger(grandTotalMinor))
    throw new Error('Total exceeds the safe integer range');
  return {
    seatCount,
    ticketSubtotalMinor,
    platformFeePerSeatMinor: policy.platformFeePerSeatMinor,
    platformFeeMinor,
    vatRateBps: policy.vatRateBps,
    vatMinor,
    grandTotalMinor,
  };
}

export interface RefundComponents {
  ticketMinor: number;
  platformFeeMinor: number;
  vatMinor: number;
  totalMinor: number;
}

export interface RefundComponentPolicy {
  /** Return the platform fee on an eligible cancellation (REFUND_PLATFORM_FEE). */
  refundPlatformFee: boolean;
  /** Return the VAT on an eligible cancellation (REFUND_VAT). */
  refundVat: boolean;
}

/**
 * What an eligible customer cancellation returns, from the booking's own snapshot: the
 * ticket price always, the platform fee and VAT only when the configured policy says so.
 */
export function cancellationRefund(
  snapshot: Pick<Charges, 'ticketSubtotalMinor' | 'platformFeeMinor' | 'vatMinor'>,
  policy: RefundComponentPolicy,
): RefundComponents {
  const ticketMinor = snapshot.ticketSubtotalMinor;
  const platformFeeMinor = policy.refundPlatformFee ? snapshot.platformFeeMinor : 0;
  const vatMinor = policy.refundVat ? snapshot.vatMinor : 0;
  return {
    ticketMinor,
    platformFeeMinor,
    vatMinor,
    totalMinor: ticketMinor + platformFeeMinor + vatMinor,
  };
}

/** Everything back (no sale happened: late or duplicate capture). */
export function fullRefund(
  snapshot: Pick<Charges, 'ticketSubtotalMinor' | 'platformFeeMinor' | 'vatMinor'>,
): RefundComponents {
  return cancellationRefund(snapshot, { refundPlatformFee: true, refundVat: true });
}
