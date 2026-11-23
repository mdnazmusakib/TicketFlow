import { DEMO_EVENTS, DEMO_USERS, DEMO_VENUES, rowLabel } from '../../../src/db/seed/seedData';
import { assertSeedAllowed } from '../../../src/db/seed/seedGuard';
import { loadMigrationFiles } from '../../../src/db/Migrator';

describe('seed data', () => {
  it('provides demo organizer and customer accounts with unique emails', () => {
    const roles = DEMO_USERS.map((u) => u.role);
    expect(roles).toEqual(expect.arrayContaining(['ORGANIZER', 'CUSTOMER']));
    // Admins are never seeded with a repository-known password.
    expect(roles).not.toContain('ADMIN');
    const emails = DEMO_USERS.map((u) => u.email.toLowerCase());
    expect(new Set(emails).size).toBe(emails.length);
    // Uses the reserved example.com domain so no real mailbox is ever contacted.
    expect(emails.every((e) => e.endsWith('@example.com'))).toBe(true);
  });

  it('demo passwords satisfy a strong password policy', () => {
    for (const user of DEMO_USERS) {
      expect(user.password).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/);
    }
  });

  it('every event row has exactly one category and references known venues/users', () => {
    const venueKeys = new Set(DEMO_VENUES.map((v) => v.key));
    const userKeys = new Set(DEMO_USERS.map((u) => u.key));
    const ids = new Set<string>();
    for (const event of DEMO_EVENTS) {
      expect(ids.has(event.id)).toBe(false);
      ids.add(event.id);
      expect(venueKeys.has(event.venueKey)).toBe(true);
      expect(userKeys.has(event.organizerKey)).toBe(true);
      const rows = Array.from({ length: event.seatRows }, (_, i) => rowLabel(i));
      const assigned = event.categories.flatMap((c) => c.rows);
      expect([...assigned].sort()).toEqual([...rows].sort());
      expect(
        event.categories.every((c) => Number.isInteger(c.priceMinor) && c.priceMinor >= 0),
      ).toBe(true);
      if (event.pricing.strategy === 'EARLY_BIRD') {
        expect(event.pricing.deadlineOffsetMinutes).toBeLessThan(event.startOffsetMinutes);
      }
    }
  });

  it('rowLabel maps indexes to A..Z, AA..AZ', () => {
    expect(rowLabel(0)).toBe('A');
    expect(rowLabel(25)).toBe('Z');
    expect(rowLabel(26)).toBe('AA');
    expect(rowLabel(51)).toBe('AZ');
    expect(() => rowLabel(52)).toThrow('out of range');
    expect(() => rowLabel(-1)).toThrow('out of range');
  });
});

describe('assertSeedAllowed', () => {
  it('blocks production unless ALLOW_SEED is set', () => {
    expect(() => assertSeedAllowed({ isProduction: true, allowSeed: false })).toThrow(
      'Refusing to seed',
    );
    expect(() => assertSeedAllowed({ isProduction: true, allowSeed: true })).not.toThrow();
    expect(() => assertSeedAllowed({ isProduction: false, allowSeed: false })).not.toThrow();
  });
});

describe('migration files', () => {
  it('are sequential, uniquely versioned and checksummed', async () => {
    const files = await loadMigrationFiles();
    expect(files.map((f) => f.version)).toEqual(
      files.map((_, i) => String(i + 1).padStart(4, '0')),
    );
    expect(files.every((f) => /^[0-9a-f]{64}$/.test(f.checksum))).toBe(true);
    expect(files.every((f) => !f.sql.includes('\r\n'))).toBe(true);
  });
});
