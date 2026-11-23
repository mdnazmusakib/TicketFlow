import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FinanceReport } from '../src/features/admin/FinanceReport';
import { BookingDetailPage } from '../src/features/bookings/BookingDetailPage';
import type { Booking, BookingsApi } from '../src/features/bookings/bookingsApi';
import { formatVatRate, PriceBreakdown } from '../src/features/bookings/PriceBreakdown';
import { OrganizerOverview } from '../src/features/organizer/OrganizerOverview';
import { fakeDashboardApi, financeReport } from './dashboardFixtures';
import { customerUser, fakeAuthApi, organizerUser, renderRoute } from './testUtils';

/** 3 seats at BDT 500: 1,500 + 30 platform charge + 30 VAT = 1,560. */
const threeSeats = {
  currency: 'BDT',
  seatCount: 3,
  ticketSubtotalMinor: 150000,
  platformFeePerSeatMinor: 1000,
  platformFeeMinor: 3000,
  vatRateBps: 200,
  vatMinor: 3000,
  grandTotalMinor: 156000,
};

const row = (name: RegExp) => screen.getByRole('row', { name });

describe('PriceBreakdown', () => {
  it('shows ticket subtotal, platform charge, VAT and grand total separately', () => {
    render(<PriceBreakdown value={threeSeats} />);
    expect(row(/Ticket subtotal \(3 seats\)/)).toHaveTextContent(/BDT\s?1,500\.00/);
    expect(row(/Platform charge \(BDT\s?10\.00 × 3\)/)).toHaveTextContent(/BDT\s?30\.00/);
    expect(row(/VAT \(2% of ticket price\)/)).toHaveTextContent(/BDT\s?30\.00/);
    expect(row(/Total to pay/)).toHaveTextContent(/BDT\s?1,560\.00/);
    expect(screen.getByText(/platform charge is TicketFlow/)).toBeInTheDocument();
    expect(screen.getByText(/VAT is a tax/)).toBeInTheDocument();
  });

  it('one seat at BDT 500 totals BDT 520, and early-bird savings are labelled', () => {
    render(
      <PriceBreakdown
        value={{
          ...threeSeats,
          seatCount: 1,
          ticketSubtotalMinor: 50000,
          discountMinor: 5000,
          platformFeeMinor: 1000,
          vatMinor: 1000,
          grandTotalMinor: 52000,
        }}
      />,
    );
    expect(row(/Ticket subtotal \(1 seat\)/)).toBeInTheDocument();
    expect(row(/Early-bird savings/)).toHaveTextContent(/BDT\s?50\.00/);
    expect(row(/Total to pay/)).toHaveTextContent(/BDT\s?520\.00/);
  });

  it('bookings made before fees existed show only the total', () => {
    render(
      <PriceBreakdown
        value={{
          ...threeSeats,
          platformFeePerSeatMinor: 0,
          platformFeeMinor: 0,
          vatRateBps: 0,
          vatMinor: 0,
          grandTotalMinor: 150000,
        }}
      />,
    );
    expect(screen.queryByText(/Platform charge/)).not.toBeInTheDocument();
    expect(screen.queryByText(/VAT/)).not.toBeInTheDocument();
    expect(row(/Total to pay/)).toHaveTextContent(/BDT\s?1,500\.00/);
  });

  it('formats VAT rates from basis points', () => {
    expect(formatVatRate(200)).toBe('2%');
    expect(formatVatRate(750)).toBe('7.5%');
    expect(formatVatRate(1525)).toBe('15.25%');
  });
});

describe('Booking receipt and refund breakdown', () => {
  const confirmed: Booking = {
    id: 'b1',
    status: 'CONFIRMED',
    eventId: 'e1',
    event: {
      title: 'Rock Night',
      startAt: '2027-01-10T14:00:00.000Z',
      venueName: 'Arena',
      venueCity: 'Dhaka',
      timezone: 'Asia/Dhaka',
    },
    holdExpiresAt: null,
    pricingStrategy: 'BASE',
    totalAmountMinor: 156000,
    refundAmountMinor: 0,
    currency: 'BDT',
    charges: threeSeats,
    seats: ['s1', 's2', 's3'].map((seatId, i) => ({
      seatId,
      row: 'A',
      number: i + 1,
      category: 'General',
      priceMinor: 50000,
      state: 'BOOKED',
    })),
    history: [],
    confirmedAt: '2026-11-21T10:00:00.000Z',
    cancelledAt: null,
    expiredAt: null,
    createdAt: '2026-11-21T10:00:00.000Z',
    serverTime: new Date().toISOString(),
    payments: [],
    refunds: [],
  };

  const api = (booking: Booking) =>
    ({
      get: jest.fn().mockResolvedValue(booking),
    }) as unknown as BookingsApi;

  const route = {
    path: '/bookings/:id',
    at: '/bookings/b1',
    auth: fakeAuthApi(customerUser),
  };

  it('shows a printable receipt with the tax amount and rate', async () => {
    const print = jest.spyOn(window, 'print').mockImplementation(() => undefined);
    renderRoute(<BookingDetailPage api={api(confirmed)} />, route);
    const receipt = await screen.findByRole('region', { name: 'Receipt' });
    expect(within(receipt).getByRole('row', { name: /Total paid/ })).toHaveTextContent(
      /BDT\s?1,560\.00/,
    );
    expect(
      within(receipt).getByRole('row', { name: /VAT \(2% of ticket price\)/ }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Print receipt' }));
    expect(print).toHaveBeenCalled();
    print.mockRestore();
  });

  it('lists refunded ticket price, platform charge and VAT separately', async () => {
    const cancelled: Booking = {
      ...confirmed,
      status: 'CANCELLED',
      refundAmountMinor: 150000,
      refunds: [
        {
          id: 'r1',
          status: 'SUCCEEDED',
          amountMinor: 150000,
          ticketMinor: 150000,
          platformFeeMinor: 0,
          vatMinor: 0,
          currency: 'BDT',
          attempt: 1,
          reason: 'x',
          failureReason: null,
          processedAt: 'x',
          nextRetryAt: null,
          createdAt: 'x',
        },
      ],
    };
    renderRoute(<BookingDetailPage api={api(cancelled)} />, route);
    const refund = await screen.findByRole('region', { name: 'Refund' });
    expect(within(refund).getByText('Ticket price').nextSibling).toHaveTextContent(/1,500\.00/);
    expect(within(refund).getByText('Platform charge').nextSibling).toHaveTextContent(/0\.00/);
    expect(within(refund).getByText('VAT').nextSibling).toHaveTextContent(/0\.00/);
  });
});

describe('Admin finance report', () => {
  it('separates platform revenue, VAT liability and ticket sales, and filters by date', async () => {
    const dashboard = fakeDashboardApi();
    render(<FinanceReport api={dashboard} />);
    const stats = await screen.findByLabelText('Platform finance');
    expect(within(stats).getByText('Net platform revenue').parentElement).toHaveTextContent(
      /BDT\s?300\.00/,
    );
    expect(
      within(stats).getByText('VAT collected (tax liability)').parentElement,
    ).toHaveTextContent(/not revenue/);
    expect(within(stats).getByText('Ticket sales (organizers)')).toBeInTheDocument();
    expect(screen.getByText(/excluded from platform revenue/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('From'), '2026-11-01');
    await userEvent.type(screen.getByLabelText('To'), '2026-11-30');
    await waitFor(() =>
      expect(dashboard.adminFinance).toHaveBeenLastCalledWith(
        { from: '2026-11-01', to: '2026-11-30' },
        expect.anything(),
      ),
    );
    expect(financeReport.platformRevenue.netMinor).toBe(30000);
  });

  it('refuses a reversed range', async () => {
    const dashboard = fakeDashboardApi();
    render(<FinanceReport api={dashboard} />);
    await screen.findByLabelText('Platform finance');
    await userEvent.type(screen.getByLabelText('From'), '2026-12-01');
    await userEvent.type(screen.getByLabelText('To'), '2026-11-01');
    expect(await screen.findByText(/must not be after/)).toBeInTheDocument();
  });
});

describe('Organizer earnings', () => {
  it('shows ticket sales as earnings and platform charges + VAT as not earnings', async () => {
    renderRoute(<OrganizerOverview api={fakeDashboardApi()} />, {
      auth: fakeAuthApi(organizerUser),
    });
    const totals = await screen.findByLabelText('Sales totals');
    expect(within(totals).getByText('Ticket sales')).toBeInTheDocument();
    expect(within(totals).getByText('Net ticket sales').parentElement).toHaveTextContent(
      /BDT\s?4,000\.00/,
    );
    expect(within(totals).getByText('Not your earnings').parentElement).toHaveTextContent(
      /BDT\s?130\.00/,
    );
  });
});
