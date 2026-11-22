import { apiClient, type ApiClient } from '../../lib/apiClient';
import type { Role, User } from '../auth/authApi';
import type { BookingStatus } from '../bookings/bookingsApi';
import type { PageMeta } from '../events/types';
import type { InAppNotification } from '../notifications/notificationsApi';

export interface CustomerDashboard {
  profile: User;
  stats: {
    totalBookings: number;
    upcomingBookings: number;
    paidMinor: number;
    refundedMinor: number;
    refundsInProgress: number;
    netSpentMinor: number;
  };
  upcoming: {
    bookingId: string;
    eventTitle: string;
    startAt: string;
    venue: string;
    timezone: string;
    seatCount: number;
    totalAmountMinor: number;
    currency: string;
  }[];
  recentNotifications: InAppNotification[];
  unreadNotifications: number;
}

export interface EventSales {
  eventId: string;
  title: string;
  status: string;
  startAt: string;
  currency: string;
  pricing: {
    strategy: string;
    earlyBirdDeadline: string | null;
    earlyBirdDiscountPct: number | null;
  };
  totalSeats: number;
  soldSeats: number;
  heldSeats: number;
  availableSeats: number;
  occupancyPct: number;
  grossRevenueMinor: number;
  refundedMinor: number;
  netRevenueMinor: number;
}

export type StatusCounts = Partial<Record<string, number>>;

export interface OrganizerDashboard {
  totals: {
    events: number;
    soldSeats: number;
    heldSeats: number;
    grossRevenueMinor: number;
    refundedMinor: number;
    netRevenueMinor: number;
  };
  eventsByStatus: StatusCounts;
  bookingsByStatus: StatusCounts;
  upcomingEvents: EventSales[];
}

export interface CategorySales {
  categoryId: string;
  name: string;
  priceMinor: number;
  totalSeats: number;
  soldSeats: number;
  heldSeats: number;
}

export interface EventBookingRow {
  bookingId: string;
  status: BookingStatus;
  customerName: string;
  customerEmail: string;
  seatCount: number;
  totalAmountMinor: number;
  refundAmountMinor: number;
  currency: string;
  paymentProvider: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

export interface EventOverview {
  event: EventSales;
  categories: CategorySales[];
  bookingsByStatus: StatusCounts;
  bookings: EventBookingRow[];
  meta: PageMeta;
}

export interface AdminOverview {
  users: { customers: number; organizers: number; admins: number };
  events: number;
  bookings: number;
  paidMinor: number;
  refundedMinor: number;
  failedRefunds: number;
  openPayments: number;
  bookingsByStatus: StatusCounts;
  eventsByStatus: StatusCounts;
  notificationDelivery: StatusCounts;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  emailVerified: boolean;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export function createDashboardApi(client: ApiClient = apiClient) {
  return {
    async customer(signal?: AbortSignal) {
      return (await client.get<CustomerDashboard>('/dashboard/customer', { signal })).data;
    },
    async organizer(signal?: AbortSignal) {
      return (await client.get<OrganizerDashboard>('/dashboard/organizer', { signal })).data;
    },
    async eventOverview(
      eventId: string,
      params: { status?: BookingStatus; page?: number; pageSize?: number },
      signal?: AbortSignal,
    ): Promise<EventOverview> {
      const { data, meta } = await client.get<Omit<EventOverview, 'meta'>>(
        `/dashboard/organizer/events/${encodeURIComponent(eventId)}`,
        { query: { ...params }, signal },
      );
      return { ...data, meta: meta as unknown as PageMeta };
    },
    async adminOverview(signal?: AbortSignal) {
      return (await client.get<AdminOverview>('/admin/overview', { signal })).data;
    },
    async adminUsers(
      params: { q?: string; role?: Role; page?: number; pageSize?: number },
      signal?: AbortSignal,
    ) {
      const { data, meta } = await client.get<AdminUser[]>('/admin/users', {
        query: { ...params },
        signal,
      });
      return { items: data, meta: meta as unknown as PageMeta };
    },
  };
}

export type DashboardApi = ReturnType<typeof createDashboardApi>;
export const dashboardApi = createDashboardApi();
