import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Booking, BookingsApi, Quote } from '../src/features/bookings/bookingsApi';
import { Countdown, formatRemaining } from '../src/features/bookings/Countdown';
import { MyBookingsPage } from '../src/features/bookings/MyBookingsPage';
import { SeatSelection } from '../src/features/bookings/SeatSelection';
import type { EventsApi } from '../src/features/events/eventsApi';
import type { SeatAvailability } from '../src/features/events/types';
import { ApiError } from '../src/lib/apiClient';
import { customerUser, fakeAuthApi, organizerUser, renderRoute } from './testUtils';

const availability: SeatAvailability = {
  eventId: 'e1',
  seatMap: { rows: 2, seatsPerRow: 4 },
  categories: [{ id: 'c1', name: 'General', priceMinor: 100000, totalSeats: 8, availableSeats: 7 }],
  seats: Array.from({ length: 8 }, (_, i) => ({
    id: `s${i + 1}`,
    row: i < 4 ? 'A' : 'B',
    number: (i % 4) + 1,
    categoryId: 'c1',
    status: i === 7 ? ('UNAVAILABLE' as const) : ('AVAILABLE' as const),
  })),
};

function quoteFor(seatIds: string[]): Quote {
  return {
    currency: 'BDT',
    appliedStrategy: 'EARLY_BIRD',
    subtotalMinor: seatIds.length * 100000,
    discountMinor: seatIds.length * 10000,
    totalMinor: seatIds.length * 90000,
    lines: seatIds.map((seatId) => ({
      seatId,
      row: 'A',
      number: Number(seatId.slice(1)),
      category: 'General',
      basePriceMinor: 100000,
      discountMinor: 10000,
      unitPriceMinor: 90000,
      available: true,
    })),
  };
}

const booking: Booking = {
  id: 'b1',
  status: 'HELD',
  eventId: 'e1',
  event: {
    title: 'Rock Night',
    startAt: '2027-01-10T14:00:00.000Z',
    venueName: 'Arena',
    venueCity: 'Dhaka',
    timezone: 'Asia/Dhaka',
  },
  holdExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  pricingStrategy: 'EARLY_BIRD',
  totalAmountMinor: 180000,
  refundAmountMinor: 0,
  currency: 'BDT',
  seats: [
    { seatId: 's1', row: 'A', number: 1, category: 'General', priceMinor: 90000, state: 'HELD' },
    { seatId: 's2', row: 'A', number: 2, category: 'General', priceMinor: 90000, state: 'HELD' },
  ],
  history: [{ from: null, to: 'HELD', reason: 'seat hold', at: '2026-11-21T10:00:00.000Z' }],
  confirmedAt: null,
  cancelledAt: null,
  expiredAt: null,
  createdAt: '2026-11-21T10:00:00.000Z',
  serverTime: new Date().toISOString(),
};

function fakeEventsApi(): jest.Mocked<EventsApi> {
  return {
    search: jest.fn(),
    cities: jest.fn(),
    details: jest.fn(),
    availability: jest.fn().mockResolvedValue(availability),
  } as unknown as jest.Mocked<EventsApi>;
}

function fakeBookingsApi(overrides: Partial<BookingsApi> = {}): jest.Mocked<BookingsApi> {
  return {
    quote: jest.fn((_eventId: string, seatIds: string[]) => Promise.resolve(quoteFor(seatIds))),
    hold: jest.fn().mockResolvedValue(booking),
    list: jest.fn(),
    get: jest.fn().mockResolvedValue(booking),
    checkout: jest.fn().mockResolvedValue({ ...booking, status: 'PENDING_PAYMENT' }),
    cancel: jest.fn().mockResolvedValue({ ...booking, status: 'CANCELLED', holdExpiresAt: null }),
    ...overrides,
  } as unknown as jest.Mocked<BookingsApi>;
}

describe('SeatSelection', () => {
  it('lets customers pick seats, shows a server-priced summary and holds them', async () => {
    const bookingsApi = fakeBookingsApi();
    renderRoute(
      <SeatSelection eventId="e1" eventsApi={fakeEventsApi()} bookingsApi={bookingsApi} />,
      {
        path: '/events/e1',
        auth: fakeAuthApi(customerUser),
        extra: [{ path: '/bookings/:id', element: <p>Booking page</p> }],
      },
    );

    await userEvent.click(await screen.findByRole('gridcell', { name: 'Row A seat 1' }));
    await userEvent.click(screen.getByRole('gridcell', { name: 'Row A seat 2' }));
    expect(screen.getByRole('gridcell', { name: 'Row B seat 4, unavailable' })).toBeDisabled();

    expect(await screen.findByText(/Total/)).toHaveTextContent(/BDT\s?1,800\.00/);
    expect(screen.getByText(/Early-bird savings/)).toBeInTheDocument();
    await waitFor(() =>
      expect(bookingsApi.quote).toHaveBeenLastCalledWith('e1', ['s1', 's2'], expect.anything()),
    );

    await userEvent.click(screen.getByRole('button', { name: /Hold 2 seat\(s\) for 5 minutes/ }));
    expect(await screen.findByText('Booking page')).toBeInTheDocument();
    expect(bookingsApi.hold).toHaveBeenCalledWith('e1', ['s1', 's2'], expect.any(String));
  });

  it('limits selection to 6 seats', async () => {
    renderRoute(
      <SeatSelection eventId="e1" eventsApi={fakeEventsApi()} bookingsApi={fakeBookingsApi()} />,
      {
        path: '/events/e1',
        auth: fakeAuthApi(customerUser),
      },
    );
    for (const name of [
      'A seat 1',
      'A seat 2',
      'A seat 3',
      'A seat 4',
      'B seat 1',
      'B seat 2',
      'B seat 3',
    ]) {
      await userEvent.click(await screen.findByRole('gridcell', { name: `Row ${name}` }));
    }
    expect(screen.getByText('You can select up to 6 seats per event.')).toBeInTheDocument();
    expect(screen.getByRole('gridcell', { name: 'Row B seat 3' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('handles seats taken by someone else: deselects them, refreshes and explains', async () => {
    const eventsApi = fakeEventsApi();
    const bookingsApi = fakeBookingsApi({
      hold: jest
        .fn()
        .mockRejectedValue(
          new ApiError(409, 'SEATS_UNAVAILABLE', 'Some of the selected seats were just taken.', [
            { path: 'seatIds', message: 's1' },
          ]),
        ),
    });
    renderRoute(<SeatSelection eventId="e1" eventsApi={eventsApi} bookingsApi={bookingsApi} />, {
      path: '/events/e1',
      auth: fakeAuthApi(customerUser),
    });
    await userEvent.click(await screen.findByRole('gridcell', { name: 'Row A seat 1' }));
    await userEvent.click(screen.getByRole('gridcell', { name: 'Row A seat 2' }));
    await userEvent.click(screen.getByRole('button', { name: /Hold 2 seat/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('just taken');
    expect(screen.getByRole('gridcell', { name: 'Row A seat 1' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('gridcell', { name: 'Row A seat 2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => expect(eventsApi.availability).toHaveBeenCalledTimes(2));
  });

  it('polls availability for live updates', async () => {
    const eventsApi = fakeEventsApi();
    renderRoute(
      <SeatSelection
        eventId="e1"
        eventsApi={eventsApi}
        bookingsApi={fakeBookingsApi()}
        refreshMs={50}
      />,
      {
        path: '/events/e1',
      },
    );
    await screen.findByRole('gridcell', { name: 'Row A seat 1' });
    await waitFor(() => expect(eventsApi.availability.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it('asks visitors to sign in and tells organizers to use a customer account', async () => {
    const { unmount } = renderRoute(<SeatSelection eventId="e1" eventsApi={fakeEventsApi()} />, {
      path: '/events/e1',
    });
    expect(await screen.findByRole('link', { name: 'Sign in as a customer' })).toHaveAttribute(
      'href',
      '/login?next=%2Fevents%2Fe1',
    );
    expect(screen.getByRole('gridcell', { name: 'Row A seat 1' })).toBeDisabled();
    unmount();

    renderRoute(<SeatSelection eventId="e1" eventsApi={fakeEventsApi()} />, {
      path: '/events/e1',
      auth: fakeAuthApi(organizerUser),
    });
    expect(
      await screen.findByText('Bookings are made with a customer account.'),
    ).toBeInTheDocument();
  });
});

describe('Countdown', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('counts down using the server clock and fires onExpire once', () => {
    const onExpire = jest.fn();
    const serverNow = Date.now() + 60_000; // browser clock is 1 minute behind the server
    render(
      <Countdown
        expiresAt={new Date(serverNow + 3_000).toISOString()}
        serverTime={new Date(serverNow).toISOString()}
        onExpire={onExpire}
      />,
    );
    expect(screen.getByRole('timer')).toHaveTextContent('0:03 left');
    act(() => {
      jest.advanceTimersByTime(3_000);
    });
    expect(screen.getByRole('timer')).toHaveTextContent('Hold expired');
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(formatRemaining(299_001)).toBe('5:00');
    expect(formatRemaining(61_000)).toBe('1:01');
  });
});

describe('MyBookingsPage', () => {
  it('lists bookings and filters by status', async () => {
    const api = fakeBookingsApi({
      list: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'b1',
            status: 'HELD',
            eventId: 'e1',
            event: booking.event,
            seatCount: 2,
            totalAmountMinor: 180000,
            currency: 'BDT',
            holdExpiresAt: booking.holdExpiresAt,
            createdAt: booking.createdAt,
          },
        ],
        meta: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
      }),
    });
    renderRoute(<MyBookingsPage api={api} />, {
      path: '/bookings',
      auth: fakeAuthApi(customerUser),
    });
    expect(await screen.findByRole('link', { name: 'Rock Night' })).toHaveAttribute(
      'href',
      '/bookings/b1',
    );
    expect(screen.getByText(/2 seat\(s\)/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'CANCELLED');
    await waitFor(() =>
      expect(api.list).toHaveBeenLastCalledWith(
        { status: 'CANCELLED', page: 1, pageSize: 10 },
        expect.anything(),
      ),
    );
  });

  it('shows the empty state', async () => {
    const api = fakeBookingsApi({
      list: jest
        .fn()
        .mockResolvedValue({ items: [], meta: { page: 1, pageSize: 10, total: 0, totalPages: 0 } }),
    });
    renderRoute(<MyBookingsPage api={api} />, {
      path: '/bookings',
      auth: fakeAuthApi(customerUser),
    });
    expect(await screen.findByText('No bookings yet')).toBeInTheDocument();
  });
});
