export interface Pricing {
  strategy: 'BASE' | 'EARLY_BIRD';
  earlyBirdDeadline: string | null;
  earlyBirdDiscountPct: number | null;
  earlyBirdActive: boolean;
}

export interface PublicEvent {
  id: string;
  title: string;
  description: string | null;
  startAt: string;
  endAt: string | null;
  currency: string;
  bannerUrl: string | null;
  salesStartAt: string | null;
  salesEndAt: string | null;
  pricing: Pricing;
  venue: { name: string; address: string; city: string; timezone: string };
  seatMap: { rows: number; seatsPerRow: number };
  totalSeats?: number;
  availableSeats?: number;
  minPriceMinor?: number | null;
  maxPriceMinor?: number | null;
}

export interface SeatCategory {
  id: string;
  name: string;
  priceMinor: number;
  totalSeats: number;
  availableSeats: number;
}

export interface Seat {
  id: string;
  row: string;
  number: number;
  categoryId: string;
  status: 'AVAILABLE' | 'UNAVAILABLE';
}

export interface EventDetails extends PublicEvent {
  categories: SeatCategory[];
}

export interface SeatAvailability {
  eventId: string;
  seatMap: { rows: number; seatsPerRow: number };
  categories: SeatCategory[];
  seats: Seat[];
}

export type EventStatus = 'DRAFT' | 'PUBLISHED' | 'CANCELLED' | 'COMPLETED';

export interface Venue {
  id: string;
  organizerId: string;
  name: string;
  address: string;
  city: string;
  countryCode: string;
  timezone: string;
}

export interface ManagedEvent extends Omit<PublicEvent, 'venue'> {
  organizerId: string;
  status: EventStatus;
  venue:
    | Venue
    | {
        id: string;
        name: string;
        address: string;
        city: string;
        countryCode: string;
        timezone: string;
      };
  publishedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedEventDetails extends ManagedEvent {
  categories: SeatCategory[];
  seats: Seat[];
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SeatCategoryInput {
  name: string;
  priceMinor: number;
  rows: string[];
}

export interface SeatMapInput {
  rows: number;
  seatsPerRow: number;
  categories: SeatCategoryInput[];
}

export type PricingInput =
  { strategy: 'BASE' } | { strategy: 'EARLY_BIRD'; earlyBirdDeadline: string; discountPct: number };

export interface EventDetailsInput {
  venueId: string;
  title: string;
  description: string | null;
  startAt: string;
  endAt: string | null;
  pricing: PricingInput;
  salesStartAt: string | null;
  salesEndAt: string | null;
  /** Optional external https banner; uploads use the banner endpoint instead. */
  bannerUrl?: string | null;
}

export interface VenueInput {
  name: string;
  address: string;
  city: string;
  countryCode: string;
  timezone: string;
}

/** Row labels A..Z, AA..AZ — mirrors the backend seat map rules. */
export function rowLabel(index: number): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return index < 26 ? letters[index]! : `A${letters[index - 26]!}`;
}
