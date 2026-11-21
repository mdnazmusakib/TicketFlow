/**
 * Demo data for local development and reviews. Credentials here are
 * intentionally public (documented in README.md and on the login screen) and
 * must never be used in production.
 */
export type SeedRole = 'CUSTOMER' | 'ORGANIZER' | 'ADMIN';

export interface SeedUser {
  key: string;
  name: string;
  email: string;
  password: string;
  role: SeedRole;
}

export interface SeedVenue {
  key: string;
  ownerKey: string;
  name: string;
  address: string;
  city: string;
}

export interface SeedCategory {
  name: string;
  priceMinor: number;
  /** Seat rows (labels) that belong to this category. */
  rows: string[];
}

export interface SeedEvent {
  /** Fixed id keeps the seed idempotent: re-running updates instead of duplicating. */
  id: string;
  organizerKey: string;
  venueKey: string;
  title: string;
  description: string;
  status: 'DRAFT' | 'PUBLISHED';
  startOffsetMinutes: number;
  durationMinutes: number;
  pricing:
    | { strategy: 'BASE' }
    | { strategy: 'EARLY_BIRD'; deadlineOffsetMinutes: number; discountPct: number };
  seatRows: number;
  seatsPerRow: number;
  categories: SeedCategory[];
}

export const DEMO_USERS: readonly SeedUser[] = [
  {
    key: 'organizer',
    name: 'Demo Organizer',
    email: 'organizer.demo@example.com',
    password: 'Organizer@123',
    role: 'ORGANIZER',
  },
  {
    key: 'customer',
    name: 'Demo Customer',
    email: 'customer.demo@example.com',
    password: 'Customer@123',
    role: 'CUSTOMER',
  },
  {
    key: 'customer2',
    name: 'Demo Customer Two',
    email: 'customer2.demo@example.com',
    password: 'Customer@123',
    role: 'CUSTOMER',
  },
  {
    key: 'admin',
    name: 'Demo Admin',
    email: 'admin.demo@example.com',
    password: 'Admin@12345',
    role: 'ADMIN',
  },
];

export const DEMO_VENUES: readonly SeedVenue[] = [
  {
    key: 'arena',
    ownerKey: 'organizer',
    name: 'TicketFlow Arena',
    address: '12 Kemal Ataturk Avenue, Banani',
    city: 'Dhaka',
  },
  {
    key: 'riverside',
    ownerKey: 'organizer',
    name: 'Riverside Convention Hall',
    address: '45 Strand Road, Sadarghat',
    city: 'Chattogram',
  },
];

const MINUTE = 1;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEMO_EVENTS: readonly SeedEvent[] = [
  {
    id: '6f1d2c3a-0b1e-4c5d-8e9f-000000000001',
    organizerKey: 'organizer',
    venueKey: 'arena',
    title: 'Dhaka Live Music Night',
    description: 'An evening of live bands across rock, fusion and folk.',
    status: 'PUBLISHED',
    startOffsetMinutes: 30 * DAY,
    durationMinutes: 4 * HOUR,
    pricing: { strategy: 'BASE' },
    seatRows: 8,
    seatsPerRow: 12,
    categories: [
      { name: 'VIP', priceMinor: 350_000, rows: ['A', 'B'] },
      { name: 'Regular', priceMinor: 150_000, rows: ['C', 'D', 'E', 'F'] },
      { name: 'Economy', priceMinor: 80_000, rows: ['G', 'H'] },
    ],
  },
  {
    id: '6f1d2c3a-0b1e-4c5d-8e9f-000000000002',
    organizerKey: 'organizer',
    venueKey: 'riverside',
    title: 'Chattogram Tech Summit',
    description: 'Talks and workshops on cloud, AI and product engineering.',
    status: 'PUBLISHED',
    startOffsetMinutes: 45 * DAY,
    durationMinutes: 8 * HOUR,
    pricing: { strategy: 'EARLY_BIRD', deadlineOffsetMinutes: 10 * DAY, discountPct: 20 },
    seatRows: 6,
    seatsPerRow: 10,
    categories: [
      { name: 'Premium', priceMinor: 250_000, rows: ['A', 'B'] },
      { name: 'Standard', priceMinor: 120_000, rows: ['C', 'D', 'E', 'F'] },
    ],
  },
  {
    id: '6f1d2c3a-0b1e-4c5d-8e9f-000000000003',
    organizerKey: 'organizer',
    venueKey: 'arena',
    title: 'Classical Evening (starts soon)',
    description:
      'Short-notice recital, useful for testing the 1-hour reminder and the no-refund window.',
    status: 'PUBLISHED',
    startOffsetMinutes: 3 * HOUR,
    durationMinutes: 2 * HOUR,
    pricing: { strategy: 'BASE' },
    seatRows: 4,
    seatsPerRow: 6,
    categories: [{ name: 'General', priceMinor: 50_000, rows: ['A', 'B', 'C', 'D'] }],
  },
  {
    id: '6f1d2c3a-0b1e-4c5d-8e9f-000000000004',
    organizerKey: 'organizer',
    venueKey: 'arena',
    title: 'Stand-up Comedy Showcase',
    description: 'Draft event, visible to its organizer only.',
    status: 'DRAFT',
    startOffsetMinutes: 60 * DAY,
    durationMinutes: 2 * HOUR,
    pricing: { strategy: 'BASE' },
    seatRows: 5,
    seatsPerRow: 8,
    categories: [{ name: 'General', priceMinor: 60_000, rows: ['A', 'B', 'C', 'D', 'E'] }],
  },
];

/** Row labels A..Z, AA..AZ — matches the schema limit of 52 rows. */
export function rowLabel(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 52)
    throw new Error('Row index out of range');
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return index < 26 ? letters[index]! : `A${letters[index - 26]!}`;
}
