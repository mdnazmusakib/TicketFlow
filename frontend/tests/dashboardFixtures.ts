import type {
  AdminOverview,
  AdminUser,
  CustomerDashboard,
  DashboardApi,
  EventOverview,
  EventSales,
  OrganizerDashboard,
} from '../src/features/dashboard/dashboardApi';
import type {
  InAppNotification,
  NotificationsApi,
} from '../src/features/notifications/notificationsApi';
import { customerUser } from './testUtils';

export const notification = (overrides: Partial<InAppNotification> = {}): InAppNotification => ({
  id: 'n1',
  type: 'BOOKING_CONFIRMED',
  title: 'Booking confirmed',
  message: 'Your booking for Rock Night is confirmed.',
  bookingId: 'b1',
  isRead: false,
  readAt: null,
  createdAt: '2026-11-21T10:00:00.000Z',
  ...overrides,
});

export const eventSales: EventSales = {
  eventId: 'e1',
  title: 'Rock Night',
  status: 'PUBLISHED',
  startAt: '2027-01-10T14:00:00.000Z',
  currency: 'BDT',
  pricing: {
    strategy: 'EARLY_BIRD',
    earlyBirdDeadline: '2026-12-31T18:00:00.000Z',
    earlyBirdDiscountPct: 10,
  },
  totalSeats: 20,
  soldSeats: 5,
  heldSeats: 2,
  availableSeats: 13,
  occupancyPct: 25,
  grossRevenueMinor: 500000,
  refundedMinor: 100000,
  netRevenueMinor: 400000,
};

export const customerDashboard: CustomerDashboard = {
  profile: customerUser,
  stats: {
    totalBookings: 3,
    upcomingBookings: 1,
    paidMinor: 300000,
    refundedMinor: 100000,
    refundsInProgress: 1,
    netSpentMinor: 200000,
  },
  upcoming: [
    {
      bookingId: 'b1',
      eventTitle: 'Rock Night',
      startAt: '2027-01-10T14:00:00.000Z',
      venue: 'Arena, Dhaka',
      timezone: 'Asia/Dhaka',
      seatCount: 2,
      totalAmountMinor: 200000,
      currency: 'BDT',
    },
  ],
  recentNotifications: [notification()],
  unreadNotifications: 1,
};

export const organizerDashboard: OrganizerDashboard = {
  totals: {
    events: 2,
    soldSeats: 5,
    heldSeats: 2,
    grossRevenueMinor: 500000,
    refundedMinor: 100000,
    netRevenueMinor: 400000,
  },
  eventsByStatus: { PUBLISHED: 1, DRAFT: 1 },
  bookingsByStatus: { CONFIRMED: 3, PENDING_PAYMENT: 1 },
  upcomingEvents: [eventSales],
};

export const eventOverview: EventOverview = {
  event: eventSales,
  categories: [
    {
      categoryId: 'c1',
      name: 'VIP',
      priceMinor: 200000,
      totalSeats: 5,
      soldSeats: 2,
      heldSeats: 1,
    },
    {
      categoryId: 'c2',
      name: 'Regular',
      priceMinor: 100000,
      totalSeats: 15,
      soldSeats: 3,
      heldSeats: 1,
    },
  ],
  bookingsByStatus: { CONFIRMED: 2, CANCELLED: 1 },
  bookings: [
    {
      bookingId: 'b1',
      status: 'CONFIRMED',
      customerName: 'Cara Customer',
      customerEmail: 'c***a@example.com',
      seatCount: 2,
      totalAmountMinor: 200000,
      refundAmountMinor: 0,
      currency: 'BDT',
      paymentProvider: 'SSLCOMMERZ',
      createdAt: '2026-11-20T10:00:00.000Z',
      confirmedAt: '2026-11-20T10:02:00.000Z',
    },
    {
      bookingId: 'b2',
      status: 'CANCELLED',
      customerName: 'Dev Customer',
      customerEmail: 'd***v@example.com',
      seatCount: 1,
      totalAmountMinor: 100000,
      refundAmountMinor: 100000,
      currency: 'BDT',
      paymentProvider: 'MOCK_PROVIDER_B',
      createdAt: '2026-11-19T10:00:00.000Z',
      confirmedAt: null,
    },
  ],
  meta: { page: 1, pageSize: 20, total: 2, totalPages: 1 },
};

export const adminOverview: AdminOverview = {
  users: { customers: 10, organizers: 3, admins: 1 },
  events: 6,
  bookings: 40,
  paidMinor: 9_000_000,
  refundedMinor: 500_000,
  failedRefunds: 1,
  openPayments: 2,
  bookingsByStatus: { CONFIRMED: 30, CANCELLED: 10 },
  eventsByStatus: { PUBLISHED: 5, DRAFT: 1 },
  notificationDelivery: { SENT: 70, FAILED: 1 },
};

export const adminUser = (overrides: Partial<AdminUser> = {}): AdminUser => ({
  id: 'u1',
  name: 'Olivia Organizer',
  email: 'olivia@example.com',
  role: 'ORGANIZER',
  emailVerified: true,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
  ...overrides,
});

export function fakeDashboardApi(): jest.Mocked<DashboardApi> {
  return {
    customer: jest.fn().mockResolvedValue(customerDashboard),
    organizer: jest.fn().mockResolvedValue(organizerDashboard),
    eventOverview: jest.fn().mockResolvedValue(eventOverview),
    adminOverview: jest.fn().mockResolvedValue(adminOverview),
    adminUsers: jest.fn().mockResolvedValue({
      items: [adminUser()],
      meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    }),
  } as unknown as jest.Mocked<DashboardApi>;
}

export function fakeNotificationsApi(
  items: InAppNotification[] = [notification()],
): jest.Mocked<NotificationsApi> {
  const unread = () => items.filter((n) => !n.isRead).length;
  return {
    list: jest.fn(async (params: { unreadOnly?: boolean; page?: number }) => {
      const visible = params.unreadOnly ? items.filter((n) => !n.isRead) : items;
      return {
        items: visible,
        meta: {
          page: params.page ?? 1,
          pageSize: 10,
          total: visible.length,
          totalPages: visible.length ? 1 : 0,
          unreadCount: unread(),
        },
      };
    }),
    unreadCount: jest.fn(async () => unread()),
    markRead: jest.fn(async (id: string) => {
      const target = items.find((n) => n.id === id)!;
      target.isRead = true;
      return target;
    }),
    markAllRead: jest.fn(async () => {
      const updated = unread();
      for (const n of items) n.isRead = true;
      return { updated, unreadCount: 0 };
    }),
  } as unknown as jest.Mocked<NotificationsApi>;
}
