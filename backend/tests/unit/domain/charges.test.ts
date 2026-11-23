import {
  cancellationRefund,
  computeCharges,
  fullRefund,
  vatOf,
} from '../../../src/domain/pricing/charges';
import { formatRate } from '../../../src/domain/notifications/templates';

const POLICY = { platformFeePerSeatMinor: 1000, vatRateBps: 200 }; // BDT 10 per seat, 2 %

describe('platform fee and VAT', () => {
  it('one seat at BDT 500: 500 + 10 + 10 = BDT 520', () => {
    expect(computeCharges(50000, 1, POLICY)).toEqual({
      seatCount: 1,
      ticketSubtotalMinor: 50000,
      platformFeePerSeatMinor: 1000,
      platformFeeMinor: 1000,
      vatRateBps: 200,
      vatMinor: 1000,
      grandTotalMinor: 52000,
    });
  });

  it('three seats at BDT 500: 1,500 + 30 + 30 = BDT 1,560 (the example in the requirements)', () => {
    const charges = computeCharges(3 * 50000, 3, POLICY);
    expect(charges).toMatchObject({
      ticketSubtotalMinor: 150000,
      platformFeeMinor: 3000,
      vatMinor: 3000,
      grandTotalMinor: 156000,
    });
  });

  it('mixed ticket prices: VAT on the whole ticket subtotal, fee per seat', () => {
    // VIP 2,000 + Regular 1,000 + Economy 800 = 3,800 → VAT 76, fee 30.
    expect(computeCharges(200000 + 100000 + 80000, 3, POLICY)).toMatchObject({
      platformFeeMinor: 3000,
      vatMinor: 7600,
      grandTotalMinor: 390600,
    });
  });

  it('rounds VAT half-up to whole paisa with integer arithmetic', () => {
    expect(vatOf(33333, 200)).toBe(667); // 666.66 → 667
    expect(vatOf(25, 200)).toBe(1); // 0.5 → 1
    expect(vatOf(24, 200)).toBe(0); // 0.48 → 0
    expect(vatOf(12345, 750)).toBe(926); // 925.875 → 926
    expect(vatOf(0, 200)).toBe(0);
    // No floating-point drift: 0.1 + 0.2 style sums stay exact.
    const total = computeCharges(10 + 20, 1, POLICY).grandTotalMinor;
    expect(Number.isInteger(total)).toBe(true);
    expect(total).toBe(30 + 1000 + 1);
  });

  it('rejects zero/negative/fractional seat counts, negative or fractional amounts and bad rates', () => {
    expect(() => computeCharges(50000, 0, POLICY)).toThrow('Seat count');
    expect(() => computeCharges(50000, -1, POLICY)).toThrow('Seat count');
    expect(() => computeCharges(50000, 1.5, POLICY)).toThrow('Seat count');
    expect(() => computeCharges(-1, 1, POLICY)).toThrow('non-negative integer');
    expect(() => computeCharges(100.5, 1, POLICY)).toThrow('non-negative integer');
    expect(() => computeCharges(1, 1, { ...POLICY, vatRateBps: 10_001 })).toThrow('at most 100%');
    expect(() => computeCharges(1, 1, { ...POLICY, platformFeePerSeatMinor: -5 })).toThrow();
    expect(() => vatOf(Number.MAX_SAFE_INTEGER, 200)).toThrow('too large');
  });

  it('a zero policy reproduces the old ticket-only totals', () => {
    expect(
      computeCharges(150000, 3, { platformFeePerSeatMinor: 0, vatRateBps: 0 }).grandTotalMinor,
    ).toBe(150000);
  });

  it('formats the VAT rate for receipts', () => {
    expect(formatRate(200)).toBe('2%');
    expect(formatRate(750)).toBe('7.5%');
    expect(formatRate(1525)).toBe('15.25%');
  });
});

describe('refund components', () => {
  const snapshot = { ticketSubtotalMinor: 150000, platformFeeMinor: 3000, vatMinor: 3000 };

  it('default policy returns the ticket price only', () => {
    expect(cancellationRefund(snapshot, { refundPlatformFee: false, refundVat: false })).toEqual({
      ticketMinor: 150000,
      platformFeeMinor: 0,
      vatMinor: 0,
      totalMinor: 150000,
    });
  });

  it('each charge can be included by policy, and never mixed into another component', () => {
    expect(cancellationRefund(snapshot, { refundPlatformFee: false, refundVat: true })).toEqual({
      ticketMinor: 150000,
      platformFeeMinor: 0,
      vatMinor: 3000,
      totalMinor: 153000,
    });
    expect(fullRefund(snapshot)).toEqual({
      ticketMinor: 150000,
      platformFeeMinor: 3000,
      vatMinor: 3000,
      totalMinor: 156000,
    });
  });
});
