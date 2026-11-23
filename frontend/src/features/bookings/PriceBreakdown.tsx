import { formatMoney } from '../../lib/format';

export interface PriceBreakdownValues {
  currency: string;
  seatCount: number;
  /** Ticket prices after any discount. */
  ticketSubtotalMinor: number;
  /** Early-bird savings already deducted from the ticket subtotal. */
  discountMinor?: number;
  platformFeePerSeatMinor: number;
  platformFeeMinor: number;
  vatRateBps: number;
  vatMinor: number;
  grandTotalMinor: number;
}

/** "2%" / "7.5%" from basis points. */
export function formatVatRate(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  return fraction === 0
    ? `${whole}%`
    : `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}%`;
}

/**
 * Transparent price breakdown: ticket subtotal, platform charge (TicketFlow's fee per seat)
 * and VAT (a tax on the ticket price) shown separately, then the grand total.
 */
export function PriceBreakdown({
  value,
  title = 'Price breakdown',
  totalLabel = 'Total to pay',
}: {
  value: PriceBreakdownValues;
  title?: string;
  totalLabel?: string;
}) {
  const money = (minor: number) => formatMoney(minor, value.currency);
  const hasCharges = value.platformFeeMinor > 0 || value.vatMinor > 0;
  return (
    <section className="price-breakdown" aria-label={title}>
      <h3 className="price-breakdown__title">{title}</h3>
      <table className="table price-breakdown__table">
        <tbody>
          <tr>
            <th scope="row">
              Ticket subtotal ({value.seatCount} seat{value.seatCount === 1 ? '' : 's'})
            </th>
            <td>{money(value.ticketSubtotalMinor)}</td>
          </tr>
          {(value.discountMinor ?? 0) > 0 && (
            <tr className="muted">
              <th scope="row">Early-bird savings (included above)</th>
              <td>−{money(value.discountMinor!)}</td>
            </tr>
          )}
          {hasCharges && (
            <>
              <tr>
                <th scope="row">
                  Platform charge ({money(value.platformFeePerSeatMinor)} × {value.seatCount})
                </th>
                <td>{money(value.platformFeeMinor)}</td>
              </tr>
              <tr>
                <th scope="row">VAT ({formatVatRate(value.vatRateBps)} of ticket price)</th>
                <td>{money(value.vatMinor)}</td>
              </tr>
            </>
          )}
          <tr className="price-breakdown__total">
            <th scope="row">{totalLabel}</th>
            <td>
              <strong>{money(value.grandTotalMinor)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
      {hasCharges && (
        <p className="field__hint">
          The platform charge is TicketFlow&apos;s service fee. VAT is a tax collected on the ticket
          price and passed on to the tax authority.
        </p>
      )}
    </section>
  );
}
