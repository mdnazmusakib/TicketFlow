import type { EventRecord, EventStats } from '../../repositories/EventRepository';
import type { SeatCategoryRecord, SeatRecord } from '../../repositories/SeatMapRepository';
import type { VenueRecord } from '../../repositories/VenueRepository';

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export interface PricingDto {
  strategy: 'BASE' | 'EARLY_BIRD';
  earlyBirdDeadline: string | null;
  earlyBirdDiscountPct: number | null;
  /** True while the early-bird discount window is open. */
  earlyBirdActive: boolean;
}

export function toPricingDto(event: EventRecord, now: Date = new Date()): PricingDto {
  return {
    strategy: event.pricingStrategy,
    earlyBirdDeadline: iso(event.earlyBirdDeadline),
    earlyBirdDiscountPct: event.earlyBirdDiscountPct,
    earlyBirdActive:
      event.pricingStrategy === 'EARLY_BIRD' &&
      event.earlyBirdDeadline !== null &&
      event.earlyBirdDeadline.getTime() > now.getTime(),
  };
}

/** Public event shape: no organizer id, no internal timestamps beyond what users need. */
export function toPublicEventDto(event: EventRecord & Partial<EventStats>) {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    startAt: event.startAt.toISOString(),
    endAt: iso(event.endAt),
    currency: event.currency,
    bannerUrl: event.bannerUrl,
    salesStartAt: iso(event.salesStartAt),
    salesEndAt: iso(event.salesEndAt),
    pricing: toPricingDto(event),
    venue: {
      name: event.venue.name,
      address: event.venue.address,
      city: event.venue.city,
      timezone: event.venue.timezone,
    },
    seatMap: { rows: event.seatRows, seatsPerRow: event.seatsPerRow },
    ...(event.totalSeats !== undefined
      ? {
          totalSeats: event.totalSeats,
          availableSeats: event.availableSeats ?? 0,
          minPriceMinor: event.minPriceMinor ?? null,
          maxPriceMinor: event.maxPriceMinor ?? null,
        }
      : {}),
  };
}

/** Organizer/admin shape: adds lifecycle and ownership fields. */
export function toManagedEventDto(event: EventRecord & Partial<EventStats>) {
  return {
    ...toPublicEventDto(event),
    organizerId: event.organizerId,
    status: event.status,
    venue: event.venue,
    publishedAt: iso(event.publishedAt),
    cancelledAt: iso(event.cancelledAt),
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}

export function toCategoryDto(category: SeatCategoryRecord) {
  return {
    id: category.id,
    name: category.name,
    priceMinor: category.priceMinor,
    totalSeats: category.totalSeats,
    availableSeats: category.availableSeats,
  };
}

export function toSeatDto(seat: SeatRecord) {
  return {
    id: seat.id,
    row: seat.rowLabel,
    number: seat.seatNumber,
    categoryId: seat.categoryId,
    status: seat.status,
  };
}

export function toVenueDto(venue: VenueRecord) {
  return {
    id: venue.id,
    organizerId: venue.organizerId,
    name: venue.name,
    address: venue.address,
    city: venue.city,
    countryCode: venue.countryCode,
    timezone: venue.timezone,
    createdAt: venue.createdAt.toISOString(),
    updatedAt: venue.updatedAt.toISOString(),
  };
}
