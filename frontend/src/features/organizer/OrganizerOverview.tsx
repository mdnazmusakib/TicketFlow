import { useCallback } from 'react';
import { Link } from 'react-router';
import { ErrorMessage, StatusBadge } from '../../components/ui/Feedback';
import { Spinner } from '../../components/ui/Spinner';
import { StatGrid, StatusCounts } from '../../components/ui/Stats';
import { toErrorMessage } from '../../lib/apiClient';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import {
  dashboardApi as defaultApi,
  type DashboardApi,
  type EventSales,
} from '../dashboard/dashboardApi';

export function Occupancy({
  event,
}: {
  event: Pick<EventSales, 'occupancyPct' | 'soldSeats' | 'totalSeats'>;
}) {
  return (
    <div>
      <div
        className="meter"
        role="meter"
        aria-label="Seats sold"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={event.occupancyPct}
      >
        <span className="meter__fill" style={{ width: `${event.occupancyPct}%` }} />
      </div>
      <span className="muted">
        {event.soldSeats}/{event.totalSeats} sold ({event.occupancyPct}%)
      </span>
    </div>
  );
}

export function pricingLabel(pricing: EventSales['pricing']): string {
  if (pricing.strategy === 'EARLY_BIRD' && pricing.earlyBirdDiscountPct) {
    const until = pricing.earlyBirdDeadline
      ? ` until ${formatDateTime(pricing.earlyBirdDeadline)}`
      : '';
    return `Early bird −${pricing.earlyBirdDiscountPct}%${until}`;
  }
  return 'Base price';
}

/** Organizer (or admin: all organizers) sales and booking statistics. */
export function OrganizerOverview({ api = defaultApi }: { api?: DashboardApi }) {
  const overview = useAsync(useCallback((signal: AbortSignal) => api.organizer(signal), [api]));
  if (overview.status === 'loading') return <Spinner label="Loading sales overview" />;
  if (overview.status === 'error') {
    return <ErrorMessage message={toErrorMessage(overview.error)} onRetry={overview.reload} />;
  }
  const { totals, eventsByStatus, bookingsByStatus, upcomingEvents } = overview.data;
  const currency = upcomingEvents[0]?.currency ?? 'BDT';
  return (
    <section className="dashboard" aria-labelledby="overview-heading">
      <h2 id="overview-heading" className="visually-hidden">
        Sales overview
      </h2>
      <StatGrid
        label="Sales totals"
        stats={[
          { label: 'Events', value: totals.events },
          { label: 'Seats sold', value: totals.soldSeats, hint: `${totals.heldSeats} on hold` },
          { label: 'Gross revenue', value: formatMoney(totals.grossRevenueMinor, currency) },
          {
            label: 'Net revenue',
            value: formatMoney(totals.netRevenueMinor, currency),
            hint: `${formatMoney(totals.refundedMinor, currency)} refunded`,
          },
        ]}
      />
      <div className="dashboard__columns">
        <div className="card">
          <h3>Events by status</h3>
          <StatusCounts counts={eventsByStatus} label="Events by status" empty="No events yet" />
          <h3>Bookings by status</h3>
          <StatusCounts
            counts={bookingsByStatus}
            label="Bookings by status"
            empty="No bookings yet"
          />
        </div>
        <div className="card">
          <h3>Upcoming events</h3>
          {upcomingEvents.length === 0 ? (
            <p className="muted">No upcoming events.</p>
          ) : (
            <ul className="list">
              {upcomingEvents.map((event) => (
                <li key={event.eventId} className="list__item">
                  <div>
                    <Link to={`/organizer/events/${event.eventId}/bookings`}>
                      <strong>{event.title}</strong>
                    </Link>{' '}
                    <StatusBadge status={event.status} />
                    <div className="muted">
                      {formatDateTime(event.startAt)} · {pricingLabel(event.pricing)} ·{' '}
                      {formatMoney(event.netRevenueMinor, event.currency)}
                    </div>
                  </div>
                  <Occupancy event={event} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
