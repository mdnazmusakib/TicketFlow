import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../src/app/routes';
import { AccountPage } from '../src/features/account/AccountPage';
import { AdminPage } from '../src/features/admin/AdminPage';
import { AuthProvider } from '../src/features/auth/AuthContext';
import type { User } from '../src/features/auth/authApi';
import { NotificationBell } from '../src/features/notifications/NotificationBell';
import { announceNotificationsChanged } from '../src/features/notifications/notificationsApi';
import { NotificationsPage } from '../src/features/notifications/NotificationsPage';
import { EventBookingsPage } from '../src/features/organizer/EventBookingsPage';
import { OrganizerOverview } from '../src/features/organizer/OrganizerOverview';
import { ApiError } from '../src/lib/apiClient';
import {
  adminUser,
  customerDashboard,
  fakeDashboardApi,
  fakeNotificationsApi,
  notification,
} from './dashboardFixtures';
import { customerUser, fakeAuthApi, organizerUser, renderRoute } from './testUtils';

const adminAccount: User = { ...organizerUser, id: 'u-adm', name: 'Ada Admin', role: 'ADMIN' };

describe('NotificationsPage', () => {
  it('lists notifications, marks one and all as read, and refreshes the badge', async () => {
    const api = fakeNotificationsApi([
      notification({ id: 'n1', title: 'Booking confirmed' }),
      notification({
        id: 'n2',
        type: 'EVENT_REMINDER_1H',
        title: 'Your event starts soon',
        bookingId: null,
      }),
    ]);
    const changed = jest.fn();
    window.addEventListener('tf:notifications-changed', changed);
    renderRoute(<NotificationsPage api={api} />, {
      path: '/notifications',
      auth: fakeAuthApi(customerUser),
    });

    expect(await screen.findByText('Your event starts soon')).toBeInTheDocument();
    expect(screen.getByText('2 unread')).toBeInTheDocument();
    expect(screen.getAllByText('(unread)')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'View booking' })).toHaveAttribute(
      'href',
      '/bookings/b1',
    );

    await userEvent.click(screen.getAllByRole('button', { name: 'Mark as read' })[0]!);
    await waitFor(() => expect(screen.getByText('1 unread')).toBeInTheDocument());
    expect(api.markRead).toHaveBeenCalledWith('n1');
    expect(changed).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    expect(await screen.findByText('You are all caught up.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
    window.removeEventListener('tf:notifications-changed', changed);
  });

  it('filters unread only and shows an empty state', async () => {
    const api = fakeNotificationsApi([
      notification({ isRead: true, readAt: '2026-11-21T11:00:00.000Z' }),
    ]);
    renderRoute(<NotificationsPage api={api} />, {
      path: '/notifications',
      auth: fakeAuthApi(customerUser),
    });
    expect(await screen.findByText('Booking confirmed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Unread' }));
    expect(await screen.findByText('No unread notifications')).toBeInTheDocument();
    expect(api.list).toHaveBeenLastCalledWith(
      { unreadOnly: true, page: 1, pageSize: 10 },
      expect.anything(),
    );
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows load and action errors with retry', async () => {
    const api = fakeNotificationsApi();
    api.list.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'Server unavailable'));
    renderRoute(<NotificationsPage api={api} />, {
      path: '/notifications',
      auth: fakeAuthApi(customerUser),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Booking confirmed')).toBeInTheDocument();

    api.markRead.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Notification not found'));
    await userEvent.click(screen.getByRole('button', { name: 'Mark as read' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Notification not found');
  });
});

describe('NotificationBell', () => {
  it('shows the unread count and refreshes when the inbox changes', async () => {
    const items = [notification({ id: 'a' }), notification({ id: 'b' })];
    const api = fakeNotificationsApi(items);
    renderRoute(<NotificationBell api={api} />, { auth: fakeAuthApi(customerUser) });
    expect(await screen.findByRole('link', { name: 'Notifications, 2 unread' })).toHaveAttribute(
      'href',
      '/notifications',
    );
    items[0]!.isRead = true;
    items[1]!.isRead = true;
    act(() => announceNotificationsChanged());
    expect(await screen.findByRole('link', { name: 'Notifications' })).toBeInTheDocument();
    expect(api.unreadCount).toHaveBeenCalledTimes(2);
  });

  it('caps the badge and ignores failures', async () => {
    const api = fakeNotificationsApi();
    api.unreadCount.mockResolvedValueOnce(150);
    renderRoute(<NotificationBell api={api} />, { auth: fakeAuthApi(customerUser) });
    expect(await screen.findByText('99+')).toBeInTheDocument();
    api.unreadCount.mockRejectedValueOnce(new Error('offline'));
    act(() => announceNotificationsChanged());
    await waitFor(() => expect(api.unreadCount).toHaveBeenCalledTimes(2));
    expect(screen.getByText('99+')).toBeInTheDocument();
  });
});

describe('Customer dashboard', () => {
  it('shows stats, upcoming bookings, notifications and profile', async () => {
    const api = fakeDashboardApi();
    renderRoute(<AccountPage api={api} />, { path: '/account', auth: fakeAuthApi(customerUser) });
    expect(await screen.findByRole('heading', { name: 'My dashboard' })).toBeInTheDocument();
    const stats = await screen.findByLabelText('Booking summary');
    expect(within(stats).getByText('3')).toBeInTheDocument();
    expect(within(stats).getByText('1 in progress')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rock Night' })).toHaveAttribute(
      'href',
      '/bookings/b1',
    );
    expect(screen.getByRole('heading', { name: 'Notifications (1 unread)' })).toBeInTheDocument();
    expect(screen.getByText('cara@example.com')).toBeInTheDocument();
  });

  it('empty and error states', async () => {
    const api = fakeDashboardApi();
    api.customer
      .mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'Try again later'))
      .mockResolvedValueOnce({
        ...customerDashboard,
        upcoming: [],
        recentNotifications: [],
        unreadNotifications: 0,
      });
    renderRoute(<AccountPage api={api} />, { path: '/account', auth: fakeAuthApi(customerUser) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again later');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No upcoming events')).toBeInTheDocument();
    expect(screen.getByText('No notifications yet.')).toBeInTheDocument();
  });

  it('organizers and admins get role shortcuts instead', async () => {
    const api = fakeDashboardApi();
    renderRoute(<AccountPage api={api} />, { path: '/account', auth: fakeAuthApi(adminAccount) });
    expect(await screen.findByRole('link', { name: 'Admin console' })).toHaveAttribute(
      'href',
      '/admin',
    );
    expect(screen.getByRole('link', { name: 'Organizer dashboard' })).toBeInTheDocument();
    expect(api.customer).not.toHaveBeenCalled();
  });
});

describe('Organizer dashboard', () => {
  it('overview shows totals, status breakdowns, pricing and occupancy', async () => {
    renderRoute(<OrganizerOverview api={fakeDashboardApi()} />, {
      auth: fakeAuthApi(organizerUser),
    });
    const totals = await screen.findByLabelText('Sales totals');
    expect(within(totals).getByText('2')).toBeInTheDocument();
    expect(within(totals).getByText('2 on hold')).toBeInTheDocument();
    expect(screen.getByLabelText('Bookings by status')).toHaveTextContent('pending payment: 1');
    expect(screen.getByRole('link', { name: 'Rock Night' })).toHaveAttribute(
      'href',
      '/organizer/events/e1/bookings',
    );
    expect(screen.getByText(/Early bird −10%/)).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Seats sold' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
  });

  it('event bookings page: categories, masked attendees, status filter', async () => {
    const api = fakeDashboardApi();
    renderRoute(<EventBookingsPage api={api} />, {
      path: '/organizer/events/:id/bookings',
      at: '/organizer/events/e1/bookings',
      auth: fakeAuthApi(organizerUser),
    });
    expect(await screen.findByRole('heading', { name: /Rock Night/ })).toBeInTheDocument();
    expect(screen.getByText('VIP')).toBeInTheDocument();
    expect(screen.getByText('c***a@example.com')).toBeInTheDocument();
    expect(screen.getByText(/^Refunded/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'CONFIRMED');
    await waitFor(() =>
      expect(api.eventOverview).toHaveBeenLastCalledWith(
        'e1',
        { status: 'CONFIRMED', page: 1, pageSize: 20 },
        expect.anything(),
      ),
    );
  });

  it('event bookings page: not found error', async () => {
    const api = fakeDashboardApi();
    api.eventOverview.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Event not found'));
    renderRoute(<EventBookingsPage api={api} />, {
      path: '/organizer/events/:id/bookings',
      at: '/organizer/events/zzz/bookings',
      auth: fakeAuthApi(organizerUser),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Event not found');
  });
});

describe('Admin console', () => {
  it('shows platform totals, delivery stats and a searchable user directory', async () => {
    const api = fakeDashboardApi();
    renderRoute(<AdminPage api={api} />, { path: '/admin', auth: fakeAuthApi(adminAccount) });
    const totals = await screen.findByLabelText('Platform totals');
    expect(within(totals).getByText('14')).toBeInTheDocument();
    expect(within(totals).getByText('1 failed refunds · 2 open payments')).toBeInTheDocument();
    expect(screen.getByLabelText('Notification delivery')).toHaveTextContent('sent: 70');
    expect(await screen.findByText('olivia@example.com')).toBeInTheDocument();

    api.adminUsers.mockResolvedValue({
      items: [
        adminUser({
          id: 'u2',
          name: 'Cara',
          email: 'cara@example.com',
          role: 'CUSTOMER',
          emailVerified: false,
        }),
      ],
      meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    });
    await userEvent.type(screen.getByLabelText('Search name or email'), 'cara');
    await waitFor(() =>
      expect(api.adminUsers).toHaveBeenLastCalledWith(
        { q: 'cara', role: undefined, page: 1, pageSize: 20 },
        expect.anything(),
      ),
    );
    expect(await screen.findByText('Unverified')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'CUSTOMER');
    await waitFor(() =>
      expect(api.adminUsers).toHaveBeenLastCalledWith(
        { q: 'cara', role: 'CUSTOMER', page: 1, pageSize: 20 },
        expect.anything(),
      ),
    );
  });

  it('shows errors and empty results', async () => {
    const api = fakeDashboardApi();
    api.adminOverview.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Insufficient permissions'));
    api.adminUsers.mockResolvedValue({
      items: [],
      meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
    });
    renderRoute(<AdminPage api={api} />, { path: '/admin', auth: fakeAuthApi(adminAccount) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Insufficient permissions');
    expect(await screen.findByText('No users match')).toBeInTheDocument();
  });
});

describe('role-aware routing for dashboards', () => {
  function renderApp(user: User, path: string) {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ success: true, data: { unreadCount: 0 } }),
    }) as unknown as typeof fetch;
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    render(
      <AuthProvider api={fakeAuthApi(user)}>
        <RouterProvider router={router} />
      </AuthProvider>,
    );
  }

  it('blocks non-admins from the admin console', async () => {
    renderApp(organizerUser, '/admin');
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('admins see Admin and Notifications in the navigation', async () => {
    renderApp(adminAccount, '/account');
    expect(await screen.findByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Notifications' })).toHaveAttribute(
      'href',
      '/notifications',
    );
  });

  it('customers see Dashboard and are blocked from organizer pages', async () => {
    renderApp(customerUser, '/organizer/events/e1/bookings');
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/account');
  });
});
