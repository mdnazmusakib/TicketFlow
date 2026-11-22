import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../src/app/routes';
import { AccountPage } from '../src/features/account/AccountPage';
import { AuthProvider, useAuth } from '../src/features/auth/AuthContext';
import type { OrganizerApi } from '../src/features/events/eventsApi';
import type { ManagedEventDetails, Venue } from '../src/features/events/types';
import { EventFormPage } from '../src/features/organizer/EventFormPage';
import { SeatMapPage } from '../src/features/organizer/SeatMapPage';
import { VenuesPage } from '../src/features/organizer/VenuesPage';
import { ApiError } from '../src/lib/apiClient';
import { fakeDashboardApi } from './dashboardFixtures';
import { customerUser, fakeAuthApi, organizerUser, renderRoute } from './testUtils';

const venue: Venue = {
  id: 'v1',
  organizerId: 'u-org',
  name: 'Arena',
  address: '1 Road',
  city: 'Dhaka',
  countryCode: 'BD',
  timezone: 'Asia/Dhaka',
};

const managedEvent: ManagedEventDetails = {
  id: 'e1',
  organizerId: 'u-org',
  title: 'Rock Night',
  description: null,
  status: 'DRAFT',
  startAt: '2027-01-10T14:00:00.000Z',
  endAt: null,
  currency: 'BDT',
  bannerUrl: null,
  salesStartAt: null,
  salesEndAt: null,
  pricing: {
    strategy: 'BASE',
    earlyBirdDeadline: null,
    earlyBirdDiscountPct: null,
    earlyBirdActive: false,
  },
  venue,
  seatMap: { rows: 2, seatsPerRow: 2 },
  totalSeats: 4,
  availableSeats: 4,
  minPriceMinor: 50000,
  maxPriceMinor: 90000,
  publishedAt: null,
  cancelledAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  categories: [
    { id: 'c-front', name: 'Front', priceMinor: 90000, totalSeats: 2, availableSeats: 2 },
    { id: 'c-back', name: 'Back', priceMinor: 50000, totalSeats: 2, availableSeats: 2 },
  ],
  seats: [
    { id: 's1', row: 'A', number: 1, categoryId: 'c-front', status: 'AVAILABLE' },
    { id: 's2', row: 'A', number: 2, categoryId: 'c-front', status: 'AVAILABLE' },
    { id: 's3', row: 'B', number: 1, categoryId: 'c-back', status: 'UNAVAILABLE' },
    { id: 's4', row: 'B', number: 2, categoryId: 'c-back', status: 'AVAILABLE' },
  ],
};

function fakeOrganizerApi(overrides: Partial<OrganizerApi> = {}): jest.Mocked<OrganizerApi> {
  return {
    listVenues: jest.fn().mockResolvedValue([venue]),
    createVenue: jest.fn().mockResolvedValue(venue),
    updateVenue: jest.fn().mockResolvedValue(venue),
    deleteVenue: jest.fn().mockResolvedValue(undefined),
    listEvents: jest.fn(),
    getEvent: jest.fn().mockResolvedValue(managedEvent),
    createEvent: jest.fn().mockResolvedValue(managedEvent),
    updateEvent: jest.fn().mockResolvedValue(managedEvent),
    replaceSeatMap: jest.fn().mockResolvedValue(managedEvent),
    updateCategory: jest.fn().mockResolvedValue(managedEvent),
    assignSeats: jest.fn().mockResolvedValue(managedEvent),
    transition: jest.fn(),
    deleteEvent: jest.fn(),
    ...overrides,
  } as jest.Mocked<OrganizerApi>;
}

const asOrganizer = { auth: fakeAuthApi(organizerUser) };

describe('VenuesPage', () => {
  beforeEach(() => jest.spyOn(window, 'confirm').mockReturnValue(true));

  it('lists, creates, edits and deletes venues', async () => {
    const api = fakeOrganizerApi();
    renderRoute(<VenuesPage api={api} />, { path: '/organizer/venues', ...asOrganizer });
    expect(await screen.findByText('Arena')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Name'), 'New Hall');
    await userEvent.type(screen.getByLabelText('Address'), '2 Road');
    await userEvent.type(screen.getByLabelText('City'), 'Sylhet');
    await userEvent.click(screen.getByRole('button', { name: 'Add venue' }));
    expect(await screen.findByText('Venue created')).toBeInTheDocument();
    expect(api.createVenue).toHaveBeenCalledWith({
      name: 'New Hall',
      address: '2 Road',
      city: 'Sylhet',
      countryCode: 'BD',
      timezone: 'Asia/Dhaka',
    });

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Arena');
    await userEvent.clear(screen.getByLabelText('City'));
    await userEvent.type(screen.getByLabelText('City'), 'Khulna');
    await userEvent.click(screen.getByRole('button', { name: 'Save venue' }));
    expect(await screen.findByText('Venue updated')).toBeInTheDocument();
    expect(api.updateVenue).toHaveBeenCalledWith('v1', expect.objectContaining({ city: 'Khulna' }));

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Venue deleted')).toBeInTheDocument();
    expect(api.deleteVenue).toHaveBeenCalledWith('v1');
  });

  it('shows the empty state and server errors', async () => {
    const api = fakeOrganizerApi({
      listVenues: jest.fn().mockResolvedValue([]),
      createVenue: jest
        .fn()
        .mockRejectedValue(
          new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', [
            { path: 'body.timezone', message: 'Unknown IANA timezone' },
          ]),
        ),
    });
    renderRoute(<VenuesPage api={api} />, { path: '/organizer/venues', ...asOrganizer });
    expect(await screen.findByText('No venues yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add venue' }));
    expect(await screen.findByText('Unknown IANA timezone')).toBeInTheDocument();
  });
});

describe('EventFormPage', () => {
  it('creates an event with a seat map and opens its seat editor', async () => {
    const api = fakeOrganizerApi();
    renderRoute(<EventFormPage api={api} />, {
      path: '/organizer/events/new',
      ...asOrganizer,
      extra: [{ path: '/organizer/events/:id/seats', element: <p>Seat editor</p> }],
    });
    await userEvent.type(await screen.findByLabelText('Title'), 'Rock Night');
    await userEvent.type(screen.getByLabelText('Starts'), '2027-01-10T20:00');
    await userEvent.selectOptions(screen.getByLabelText('Strategy'), 'EARLY_BIRD');
    await userEvent.type(screen.getByLabelText('Discount ends'), '2027-01-01T00:00');
    expect(screen.getByText('50 seats will be generated.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create draft event' }));

    expect(await screen.findByText('Seat editor')).toBeInTheDocument();
    const payload = api.createEvent.mock.calls[0]![0];
    expect(payload).toMatchObject({
      venueId: 'v1',
      title: 'Rock Night',
      pricing: { strategy: 'EARLY_BIRD', discountPct: 10 },
      seatMap: { rows: 5, seatsPerRow: 10 },
    });
    expect(payload.startAt).toBe(new Date('2027-01-10T20:00').toISOString());
  });

  it('requires a start time and blocks invalid seat maps', async () => {
    const api = fakeOrganizerApi();
    renderRoute(<EventFormPage api={api} />, { path: '/organizer/events/new', ...asOrganizer });
    await userEvent.type(await screen.findByLabelText('Title'), 'Show');
    await userEvent.click(screen.getByRole('button', { name: 'Create draft event' }));
    expect(screen.getByText('Start date and time are required')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Starts'), '2027-01-10T20:00');
    // Unassign row A from VIP => row A uncovered.
    const vipRows = screen.getByRole('group', { name: 'Rows for VIP' });
    await userEvent.click(within(vipRows).getByRole('button', { name: 'A' }));
    expect(screen.getByText('Assign a category to rows: A')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create draft event' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Category "VIP" has no rows');
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('asks for a venue before creating events', async () => {
    const api = fakeOrganizerApi({ listVenues: jest.fn().mockResolvedValue([]) });
    renderRoute(<EventFormPage api={api} />, { path: '/organizer/events/new', ...asOrganizer });
    expect(await screen.findByRole('heading', { name: 'Add a venue first' })).toBeInTheDocument();
  });

  it('edits an existing event and surfaces business-rule errors', async () => {
    const api = fakeOrganizerApi({
      updateEvent: jest
        .fn()
        .mockRejectedValueOnce(
          new ApiError(
            409,
            'ACTIVE_BOOKINGS_EXIST',
            'Cannot change the venue or schedule: the event has active bookings',
          ),
        )
        .mockResolvedValueOnce(managedEvent),
    });
    renderRoute(<EventFormPage api={api} />, {
      path: '/organizer/events/:id/edit',
      at: '/organizer/events/e1/edit',
      ...asOrganizer,
      extra: [{ path: '/organizer', element: <p>Dashboard</p> }],
    });
    expect(await screen.findByLabelText('Title')).toHaveValue('Rock Night');
    expect(screen.queryByText(/seats will be generated/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('active bookings');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(api.updateEvent).toHaveBeenLastCalledWith(
      'e1',
      expect.objectContaining({ title: 'Rock Night', venueId: 'v1' }),
    );
  });
});

describe('SeatMapPage', () => {
  it('updates prices, reassigns selected seats and rebuilds the layout', async () => {
    const api = fakeOrganizerApi();
    renderRoute(<SeatMapPage api={api} />, {
      path: '/organizer/events/:id/seats',
      at: '/organizer/events/e1/seats',
      ...asOrganizer,
    });
    expect(await screen.findByRole('heading', { name: /Rock Night/ })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('New price for Front'), '1200.50');
    await userEvent.click(screen.getAllByRole('button', { name: 'Update price' })[0]!);
    expect(await screen.findByText('Price updated')).toBeInTheDocument();
    expect(api.updateCategory).toHaveBeenCalledWith('e1', 'c-front', { priceMinor: 120050 });

    // Organizers can select any seat (including unavailable ones) to manage categories.
    await userEvent.click(screen.getByRole('gridcell', { name: 'Row A seat 1' }));
    await userEvent.click(screen.getByRole('gridcell', { name: 'Row A seat 2' }));
    await userEvent.selectOptions(screen.getByLabelText('Move selected seats to'), 'c-back');
    await userEvent.click(screen.getByRole('button', { name: 'Apply to 2 seat(s)' }));
    expect(await screen.findByText('2 seat(s) reassigned')).toBeInTheDocument();
    expect(api.assignSeats).toHaveBeenCalledWith('e1', ['s1', 's2'], 'c-back');

    await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    expect(screen.getByLabelText('Rows (A–AZ)')).toHaveValue(2);
    await userEvent.click(screen.getByRole('button', { name: 'Save new seat map' }));
    expect(await screen.findByText('Seat map rebuilt')).toBeInTheDocument();
    expect(api.replaceSeatMap).toHaveBeenCalledWith('e1', {
      rows: 2,
      seatsPerRow: 2,
      categories: [
        { name: 'Front', priceMinor: 90000, rows: ['A'] },
        { name: 'Back', priceMinor: 50000, rows: ['B'] },
      ],
    });
  });

  it('reports when the seat map is locked by bookings', async () => {
    const api = fakeOrganizerApi({
      replaceSeatMap: jest
        .fn()
        .mockRejectedValue(
          new ApiError(409, 'RESOURCE_IN_USE', 'Seat map cannot be replaced after bookings exist'),
        ),
    });
    renderRoute(<SeatMapPage api={api} />, {
      path: '/organizer/events/:id/seats',
      at: '/organizer/events/e1/seats',
      ...asOrganizer,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit layout' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add category' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save new seat map' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/needs a name|has no rows/);
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[2]!);
    await userEvent.click(screen.getByRole('button', { name: 'Save new seat map' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('after bookings exist');
  });
});

describe('Auth context, account page and header', () => {
  it('shows the profile of the signed-in user', async () => {
    renderRoute(<AccountPage api={fakeDashboardApi()} />, {
      path: '/account',
      auth: fakeAuthApi(customerUser),
    });
    expect(await screen.findByText('cara@example.com')).toBeInTheDocument();
    expect(screen.getByText('CUSTOMER')).toBeInTheDocument();
  });

  it('shows role-aware navigation and signs out', async () => {
    const auth = fakeAuthApi(organizerUser);
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ success: true, data: { status: 'ok', timestamp: 'x', checks: {} } }),
    }) as unknown as typeof fetch;
    const router = createMemoryRouter(routes, { initialEntries: ['/'] });
    render(
      <AuthProvider api={auth}>
        <RouterProvider router={router} />
      </AuthProvider>,
    );
    expect(await screen.findByRole('link', { name: 'Organizer' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Sign out/ }));
    expect(auth.logout).toHaveBeenCalled();
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('register without verification signs the user in; useAuth outside the provider throws', async () => {
    const auth = fakeAuthApi();
    auth.register.mockResolvedValue({ user: customerUser, verificationRequired: false });
    let api: ReturnType<typeof useAuth> | undefined;
    function Probe() {
      api = useAuth();
      return <p>{api.status}</p>;
    }
    render(
      <AuthProvider api={auth}>
        <Probe />
      </AuthProvider>,
    );
    await screen.findByText('anonymous');
    await act(async () => {
      await api!.register({
        name: 'C',
        email: 'c@x.co',
        password: 'Str0ng!Pass',
        role: 'CUSTOMER',
      });
    });
    await screen.findByText('authenticated');

    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    function Orphan() {
      useAuth();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow('useAuth must be used inside <AuthProvider>');
    spy.mockRestore();
    await waitFor(() => expect(auth.me).toHaveBeenCalled());
  });
});
