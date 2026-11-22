import type { Queryable } from '../infrastructure/database/types';

export interface VenueRecord {
  id: string;
  organizerId: string;
  name: string;
  address: string;
  city: string;
  countryCode: string;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VenueInput {
  name: string;
  address: string;
  city: string;
  countryCode: string;
  timezone: string;
}

interface VenueRow {
  id: string;
  organizer_id: string;
  name: string;
  address: string;
  city: string;
  country_code: string;
  timezone: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  'id, organizer_id, name, address, city, country_code, timezone, created_at, updated_at';

const toRecord = (row: VenueRow): VenueRecord => ({
  id: row.id,
  organizerId: row.organizer_id,
  name: row.name,
  address: row.address,
  city: row.city,
  countryCode: row.country_code,
  timezone: row.timezone,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class VenueRepository {
  constructor(private readonly db: Queryable) {}

  /** organizerId = null lists every venue (ADMIN). */
  async list(organizerId: string | null): Promise<VenueRecord[]> {
    const { rows } = await this.db.query<VenueRow>(
      `SELECT ${COLUMNS} FROM venues WHERE ($1::uuid IS NULL OR organizer_id = $1)
       ORDER BY lower(name), lower(city)`,
      [organizerId],
    );
    return rows.map(toRecord);
  }

  async findById(id: string, db: Queryable = this.db): Promise<VenueRecord | null> {
    const { rows } = await db.query<VenueRow>(`SELECT ${COLUMNS} FROM venues WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async create(organizerId: string, input: VenueInput): Promise<VenueRecord> {
    const { rows } = await this.db.query<VenueRow>(
      `INSERT INTO venues (organizer_id, name, address, city, country_code, timezone)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [organizerId, input.name, input.address, input.city, input.countryCode, input.timezone],
    );
    return toRecord(rows[0]!);
  }

  async update(id: string, patch: Partial<VenueInput>): Promise<VenueRecord | null> {
    const { rows } = await this.db.query<VenueRow>(
      `UPDATE venues SET
         name = COALESCE($2, name),
         address = COALESCE($3, address),
         city = COALESCE($4, city),
         country_code = COALESCE($5, country_code),
         timezone = COALESCE($6, timezone)
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [
        id,
        patch.name ?? null,
        patch.address ?? null,
        patch.city ?? null,
        patch.countryCode ?? null,
        patch.timezone ?? null,
      ],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async countEvents(id: string): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM events WHERE venue_id = $1',
      [id],
    );
    return rows[0]?.n ?? 0;
  }

  async delete(id: string): Promise<void> {
    await this.db.query('DELETE FROM venues WHERE id = $1', [id]);
  }
}
