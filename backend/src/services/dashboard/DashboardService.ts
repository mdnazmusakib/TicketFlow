import { canManageResource, type Actor } from '../../domain/auth/roles';
import type { DashboardRepository, EventSalesStats } from '../../repositories/DashboardRepository';
import type { EventRepository } from '../../repositories/EventRepository';
import type { NotificationRepository } from '../../repositories/NotificationRepository';
import type { UserRepository } from '../../repositories/UserRepository';
import { ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import { buildPaginationMeta } from '../../shared/http/apiResponse';
import { toPublicUser } from '../auth/AuthService';
import { toInboxDto } from '../notifications/NotificationInboxService';

function salesDto(stats: EventSalesStats) {
  return {
    eventId: stats.eventId,
    title: stats.title,
    status: stats.status,
    startAt: stats.startAt.toISOString(),
    currency: stats.currency,
    pricing: {
      strategy: stats.pricingStrategy,
      earlyBirdDeadline: stats.earlyBirdDeadline?.toISOString() ?? null,
      earlyBirdDiscountPct: stats.earlyBirdDiscountPct,
    },
    totalSeats: stats.totalSeats,
    soldSeats: stats.soldSeats,
    heldSeats: stats.heldSeats,
    availableSeats: Math.max(0, stats.totalSeats - stats.soldSeats - stats.heldSeats),
    occupancyPct:
      stats.totalSeats === 0 ? 0 : Math.round((stats.soldSeats / stats.totalSeats) * 100),
    grossRevenueMinor: stats.grossRevenueMinor,
    refundedMinor: stats.refundedMinor,
    netRevenueMinor: stats.grossRevenueMinor - stats.refundedMinor,
  };
}

/** Read models for the customer, organizer and admin dashboards. Every query is scoped by role/ownership. */
export class DashboardService {
  constructor(
    private readonly dashboards: DashboardRepository,
    private readonly users: UserRepository,
    private readonly events: EventRepository,
    private readonly notifications: NotificationRepository,
  ) {}

  async customer(actor: Actor) {
    const user = await this.users.findById(actor.id);
    if (!user) throw new NotFoundError('User not found');
    const [stats, upcoming, inbox, unreadCount] = await Promise.all([
      this.dashboards.customerStats(actor.id),
      this.dashboards.upcomingForCustomer(actor.id, 5),
      this.notifications.listInbox(actor.id, { unreadOnly: false, page: 1, pageSize: 5 }),
      this.notifications.unreadCount(actor.id),
    ]);
    return {
      profile: toPublicUser(user),
      stats: { ...stats, netSpentMinor: stats.paidMinor - stats.refundedMinor },
      upcoming,
      recentNotifications: inbox.items.map(toInboxDto),
      unreadNotifications: unreadCount,
    };
  }

  async organizer(actor: Actor) {
    const scope = actor.role === 'ADMIN' ? null : actor.id;
    const [allEvents, eventsByStatus, bookingsByStatus] = await Promise.all([
      this.dashboards.eventSales(scope, {}),
      this.dashboards.eventStatusCounts(scope),
      this.dashboards.bookingStatusCounts(scope),
    ]);
    const totals = allEvents.reduce(
      (acc, e) => ({
        soldSeats: acc.soldSeats + e.soldSeats,
        heldSeats: acc.heldSeats + e.heldSeats,
        grossRevenueMinor: acc.grossRevenueMinor + e.grossRevenueMinor,
        refundedMinor: acc.refundedMinor + e.refundedMinor,
      }),
      { soldSeats: 0, heldSeats: 0, grossRevenueMinor: 0, refundedMinor: 0 },
    );
    const now = Date.now();
    return {
      totals: {
        ...totals,
        netRevenueMinor: totals.grossRevenueMinor - totals.refundedMinor,
        events: allEvents.length,
      },
      eventsByStatus,
      bookingsByStatus,
      upcomingEvents: allEvents
        .filter(
          (e) => e.startAt.getTime() > now && (e.status === 'PUBLISHED' || e.status === 'DRAFT'),
        )
        .slice(0, 10)
        .map(salesDto),
    };
  }

  async eventOverview(
    actor: Actor,
    eventId: string,
    filter: { status?: string; page: number; pageSize: number },
  ) {
    const event = await this.events.findById(eventId);
    if (!event || !canManageResource(actor, event.organizerId))
      throw new NotFoundError('Event not found');
    const [sales, categories, bookingsByStatus, bookings] = await Promise.all([
      this.dashboards.eventSales(null, { eventId }),
      this.dashboards.categorySales(eventId),
      this.dashboards.bookingStatusCounts(null, eventId),
      this.dashboards.eventBookings(eventId, filter),
    ]);
    return {
      event: salesDto(sales[0]!),
      categories,
      bookingsByStatus,
      bookings: bookings.items,
      meta: buildPaginationMeta(filter.page, filter.pageSize, bookings.total),
    };
  }

  async admin(actor: Actor) {
    if (actor.role !== 'ADMIN') throw new ForbiddenError();
    const [platform, notifications, bookingsByStatus, eventsByStatus] = await Promise.all([
      this.dashboards.platformCounts(),
      this.notifications.deliveryStats(),
      this.dashboards.bookingStatusCounts(null),
      this.dashboards.eventStatusCounts(null),
    ]);
    return { ...platform, bookingsByStatus, eventsByStatus, notificationDelivery: notifications };
  }

  async adminUsers(
    actor: Actor,
    filter: { q?: string; role?: string; page: number; pageSize: number },
  ) {
    if (actor.role !== 'ADMIN') throw new ForbiddenError();
    const { items, total } = await this.dashboards.listUsers(filter);
    return { items, meta: buildPaginationMeta(filter.page, filter.pageSize, total) };
  }
}
