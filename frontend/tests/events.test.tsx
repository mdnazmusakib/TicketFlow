import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EventDetailPage } from '../src/features/events/EventDetailPage';
import { EventsPage } from '../src/features/events/EventsPage';
import type { EventsApi, OrganizerApi } from '../src/features/events/eventsApi';
import type { EventDetails, ManagedEvent, PublicEvent } from '../src/features/events/types';
import { buildSeatMap, DEFAULT_SEAT_MAP_DRAFT } from '../src/features/organizer/SeatMapBuilder';
import { OrganizerEventsPage } from '../src/features/organizer/OrganizerEventsPage';
import { ApiError } from '../src/lib/apiClient';
import { formatMoney, fromLocalInput, toLocalInput, toMinorUnits } from '../src/lib/format';
import { fakeDashboardApi } from './dashboardFixtures';
import { fakeAuthApi, organizerUser, renderRoute } from './testUtils';

const event: PublicEvent = {
  id: 'e1',
  title: 'Rock Night',
  description: 'Loud',
  startAt: '2027-01-10T14:00:00.000Z',
  endAt: null,
  currency: 'BDT',
  bannerUrl: null,
  salesStartAt: null,
  salesEndAt: null,
  pricing: {
    strategy: 'EARLY_BIRD',
    earlyBirdDeadline: '2027-01-01T00:00:00.000Z',
    earlyBirdDiscountPct: 20,
    earlyBirdActive: true,
  },
  venue: { name: 'Arena', address: '1 Road', city: 'Dhaka', timezone: 'Asia/Dhaka' },
  seatMap: { rows: 1, seatsPerRow: 2 },
  totalSeats: 2,
  availableSeats: 1,
  minPriceMinor: 150000,
  maxPriceMinor: 150000,
};

function fakeEventsApi(overrides: Partial<EventsApi> = {}): jest.Mocked<EventsApi> {
  return {
    search: jest.fn().mockResolvedValue({
      items: [event],
      meta: { page: 1, pageSize: 12, total: 1, totalPages: 1 },
    }),
    cities: jest.fn().mockResolvedValue(['Chattogram', 'Dhaka']),
    details: jest.fn(),
    availability: jest.fn(),
    ...overrides,
  } as jest.Mocked<EventsApi>;
}

describe('EventsPage', () => {
  it('lists events with price, early-bird badge and availability', async () => {
    const api = fakeEventsApi();
    renderRoute(<EventsPage api={api} />, { path: '/events' });
    expect(await screen.findByRole('link', { name: 'Rock Night' })).toHaveAttribute(
      'href',
      '/events/e1',
    );
    expect(screen.getByText(/From BDT\s?1,500\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Early bird −20%/)).toBeInTheDocument();
    expect(screen.getByText('1 of 2 seats available')).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Dhaka' })).toBeInTheDocument();
  });

  it('pushes filters into the URL and re-queries', async () => {
    const api = fakeEventsApi();
    renderRoute(<EventsPage api={api} />, { path: '/events' });
    await screen.findByText('Rock Night');
    await userEvent.type(screen.getByLabelText('Search'), 'rock');
    await userEvent.selectOptions(await screen.findByLabelText('City'), 'Dhaka');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(api.search).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'rock', city: 'Dhaka', sort: 'date', order: 'asc', page: 1 }),
        expect.anything(),
      ),
    );
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'price:desc');
    await waitFor(() =>
      expect(api.search).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'price', order: 'desc' }),
        expect.anything(),
      ),
    );
  });

  it('shows empty and error states', async () => {
    const empty = fakeEventsApi({
      search: jest
        .fn()
        .mockResolvedValue({ items: [], meta: { page: 1, pageSize: 12, total: 0, totalPages: 0 } }),
    });
    const { unmount } = renderRoute(<EventsPage api={empty} />, { path: '/events' });
    expect(await screen.findByText('No events found')).toBeInTheDocument();
    unmount();

    const failing = fakeEventsApi({
      search: jest
        .fn()
        .mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the server')),
    });
    renderRoute(<EventsPage api={failing} />, { path: '/events' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to reach the server');
  });
});

describe('EventDetailPage', () => {
  const details: EventDetails = {
    ...event,
    categories: [
      { id: 'c1', name: 'General', priceMinor: 150000, totalSeats: 2, availableSeats: 1 },
    ],
  };

  it('shows details, ticket categories and the seat map', async () => {
    const api = fakeEventsApi({
      details: jest.fn().mockResolvedValue(details),
      availability: jest.fn().mockResolvedValue({
        eventId: 'e1',
        seatMap: { rows: 1, seatsPerRow: 2 },
        categories: details.categories,
        seats: [
          { id: 's1', row: 'A', number: 1, categoryId: 'c1', status: 'AVAILABLE' },
          { id: 's2', row: 'A', number: 2, categoryId: 'c1', status: 'UNAVAILABLE' },
        ],
      }),
    });
    renderRoute(<EventDetailPage api={api} />, { path: '/events/:id', at: '/events/e1' });
    expect(await screen.findByRole('heading', { name: 'Rock Night' })).toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    expect(
      await screen.findByRole('gridcell', { name: 'Row A seat 2, unavailable' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Early bird: 20% off/)).toBeInTheDocument();
    expect(api.details).toHaveBeenCalledWith('e1', expect.anything());
  });

  it('shows a not-found state for unpublished or unknown events', async () => {
    const api = fakeEventsApi({
      details: jest.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Event not found')),
      availability: jest.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Event not found')),
    });
    renderRoute(<EventDetailPage api={api} />, { path: '/events/:id', at: '/events/nope' });
    expect(await screen.findByRole('heading', { name: 'Event not found' })).toBeInTheDocument();
  });
});

describe('OrganizerEventsPage', () => {
  const managed = (status: ManagedEvent['status']): ManagedEvent => ({
    ...event,
    id: `m-${status}`,
    title: `${status} show`,
    organizerId: 'u-org',
    status,
    venue: {
      id: 'v1',
      name: 'Arena',
      address: '1 Road',
      city: 'Dhaka',
      countryCode: 'BD',
      timezone: 'Asia/Dhaka',
    },
    publishedAt: null,
    cancelledAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('lists own events with lifecycle actions and surfaces API errors', async () => {
    const api = {
      listEvents: jest.fn().mockResolvedValue({
        items: [managed('DRAFT'), managed('PUBLISHED')],
        meta: { page: 1, pageSize: 10, total: 2, totalPages: 1 },
      }),
      transition: jest
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(
          new ApiError(
            409,
            'ACTIVE_BOOKINGS_EXIST',
            'Cannot unpublish: the event has active bookings',
          ),
        ),
    } as unknown as OrganizerApi;

    renderRoute(<OrganizerEventsPage api={api} dashboard={fakeDashboardApi()} />, {
      path: '/organizer',
      auth: fakeAuthApi(organizerUser),
    });
    expect(await screen.findByText('DRAFT show')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('Event published')).toBeInTheDocument();
    expect(api.transition).toHaveBeenCalledWith('m-DRAFT', 'publish');

    await userEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('active bookings');
  });
});

describe('seat map builder and formatting helpers', () => {
  it('converts a valid draft into minor-unit categories', () => {
    const { value, errors } = buildSeatMap(DEFAULT_SEAT_MAP_DRAFT);
    expect(errors).toEqual([]);
    expect(value).toEqual({
      rows: 5,
      seatsPerRow: 10,
      categories: [
        { name: 'VIP', priceMinor: 250000, rows: ['A'] },
        { name: 'Regular', priceMinor: 100000, rows: ['B', 'C', 'D', 'E'] },
      ],
    });
  });

  it('reports gaps, duplicates, bad prices and bounds', () => {
    expect(buildSeatMap({ rows: '0', seatsPerRow: '200', categories: [] }).errors).toHaveLength(3);
    const { errors } = buildSeatMap({
      rows: '3',
      seatsPerRow: '2',
      categories: [
        { name: 'A', price: '10.999', rows: ['A'] },
        { name: 'a', price: '5', rows: ['A'] },
      ],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'Duplicate category name "a"',
        'Category "A" needs a valid price (e.g. 1500 or 1500.50)',
        'Row A is in more than one category',
        'Assign a category to rows: B, C',
      ]),
    );
  });

  it('formats money and converts units and dates', () => {
    expect(formatMoney(150050, 'BDT')).toMatch(/BDT\s?1,500\.50/);
    expect(toMinorUnits('1500.5')).toBe(150050);
    expect(Number.isNaN(toMinorUnits('-1'))).toBe(true);
    const iso = '2027-01-10T14:00:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(fromLocalInput('')).toBeNull();
    expect(toLocalInput(null)).toBe('');
  });
});
