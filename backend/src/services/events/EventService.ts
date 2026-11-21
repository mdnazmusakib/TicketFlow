import { canManageResource, type Actor } from '../../domain/auth/roles';
import {
  isEditableStatus,
  validateSchedule,
  type EventStatus,
  type PricingConfig,
} from '../../domain/events/eventRules';
import {
  generateSeats,
  validateSeatMap,
  type SeatMapDefinition,
} from '../../domain/events/seatMap';
import type { Queryable, TransactionRunner } from '../../infrastructure/database/types';
import type {
  EventRecord,
  EventRepository,
  EventWriteInput,
} from '../../repositories/EventRepository';
import type { SeatMapRepository } from '../../repositories/SeatMapRepository';
import type { VenueRepository } from '../../repositories/VenueRepository';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/AppError';
import { buildPaginationMeta } from '../../shared/http/apiResponse';
import { toCategoryDto, toManagedEventDto, toSeatDto } from './eventDto';

export interface EventDetailsInput {
  venueId: string;
  title: string;
  description?: string | null;
  startAt: Date;
  endAt?: Date | null;
  pricing: PricingConfig;
  salesStartAt?: Date | null;
  salesEndAt?: Date | null;
  bannerUrl?: string | null;
}

export interface CreateEventInput extends EventDetailsInput {
  seatMap: SeatMapDefinition;
}

export type UpdateEventInput = Partial<EventDetailsInput>;

const activeBookingsError = (action: string) =>
  new AppError(409, 'ACTIVE_BOOKINGS_EXIST', `Cannot ${action}: the event has active bookings`);

/**
 * Organizer-side event management. Every mutation runs in a transaction that
 * locks the event row, re-checks ownership and booking state, then writes —
 * so a check can never be invalidated between "check" and "write".
 */
export class EventService {
  constructor(
    private readonly db: TransactionRunner,
    private readonly events: EventRepository,
    private readonly seatMaps: SeatMapRepository,
    private readonly venues: VenueRepository,
    private readonly options: { defaultCurrency: string; now?: () => Date },
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async list(actor: Actor, filter: { status?: EventStatus; page: number; pageSize: number }) {
    const { items, total } = await this.events.listForOrganizer(
      actor.role === 'ADMIN' ? null : actor.id,
      filter,
    );
    return {
      items: items.map(toManagedEventDto),
      meta: buildPaginationMeta(filter.page, filter.pageSize, total),
    };
  }

  async get(actor: Actor, id: string) {
    const event = await this.events.findWithStats(id);
    if (!event || !canManageResource(actor, event.organizerId))
      throw new NotFoundError('Event not found');
    const [categories, seats] = await Promise.all([
      this.seatMaps.listCategories(id),
      this.seatMaps.listSeats(id),
    ]);
    return {
      ...toManagedEventDto(event),
      categories: categories.map(toCategoryDto),
      seats: seats.map(toSeatDto),
    };
  }

  async create(actor: Actor, input: CreateEventInput) {
    if (actor.role !== 'ORGANIZER') throw new ForbiddenError('Only organizers can create events');
    this.assertValidSchedule(input);
    this.assertValidSeatMap(input.seatMap);

    const id = await this.db.withTransaction(async (tx) => {
      const venue = await this.venues.findById(input.venueId, tx);
      // Organizers may only host events at their own venues.
      if (!venue || venue.organizerId !== actor.id) throw new NotFoundError('Venue not found');
      const eventId = await this.events.create(
        actor.id,
        this.toWriteInput(input, input.seatMap),
        tx,
      );
      await this.seatMaps.replaceSeatMap(
        eventId,
        input.seatMap.categories,
        generateSeats(input.seatMap),
        tx,
      );
      return eventId;
    });
    return this.get(actor, id);
  }

  async update(actor: Actor, id: string, patch: UpdateEventInput) {
    await this.db.withTransaction(async (tx) => {
      const event = await this.lockManaged(actor, id, tx);
      if (!isEditableStatus(event.status)) {
        throw new ConflictError(`A ${event.status.toLowerCase()} event cannot be edited`);
      }

      const merged: EventDetailsInput = {
        venueId: patch.venueId ?? event.venueId,
        title: patch.title ?? event.title,
        description: patch.description !== undefined ? patch.description : event.description,
        startAt: patch.startAt ?? event.startAt,
        endAt: patch.endAt !== undefined ? patch.endAt : event.endAt,
        pricing: patch.pricing ?? this.currentPricing(event),
        salesStartAt: patch.salesStartAt !== undefined ? patch.salesStartAt : event.salesStartAt,
        salesEndAt: patch.salesEndAt !== undefined ? patch.salesEndAt : event.salesEndAt,
        bannerUrl: patch.bannerUrl !== undefined ? patch.bannerUrl : event.bannerUrl,
      };

      const scheduleChanged =
        merged.venueId !== event.venueId ||
        merged.startAt.getTime() !== event.startAt.getTime() ||
        (merged.endAt?.getTime() ?? null) !== (event.endAt?.getTime() ?? null);
      // Moving or relocating a sold event would silently change what customers bought.
      if (scheduleChanged && (await this.events.countActiveBookings(id, tx)) > 0) {
        throw activeBookingsError('change the venue or schedule');
      }
      this.assertValidSchedule(merged);

      if (merged.venueId !== event.venueId) {
        const venue = await this.venues.findById(merged.venueId, tx);
        if (!venue || venue.organizerId !== event.organizerId)
          throw new NotFoundError('Venue not found');
      }
      await this.events.update(
        id,
        this.toWriteInput(merged, { rows: event.seatRows, seatsPerRow: event.seatsPerRow }),
        tx,
      );
    });
    return this.get(actor, id);
  }

  /** Regenerates the whole seat map. Only before any booking has ever referenced the event. */
  async replaceSeatMap(actor: Actor, id: string, seatMap: SeatMapDefinition) {
    this.assertValidSeatMap(seatMap);
    await this.db.withTransaction(async (tx) => {
      const event = await this.lockManaged(actor, id, tx);
      if (!isEditableStatus(event.status))
        throw new ConflictError('This event can no longer be edited');
      if (await this.events.hasBookingHistory(id, tx)) {
        throw new AppError(
          409,
          'RESOURCE_IN_USE',
          'Seat map cannot be replaced after bookings exist',
        );
      }
      await this.seatMaps.replaceSeatMap(id, seatMap.categories, generateSeats(seatMap), tx);
      await this.events.updateSeatMapSize(id, seatMap.rows, seatMap.seatsPerRow, tx);
    });
    return this.get(actor, id);
  }

  /** Renames or re-prices a category. Existing bookings keep their price snapshot. */
  async updateCategory(
    actor: Actor,
    id: string,
    categoryId: string,
    patch: { name?: string; priceMinor?: number },
  ) {
    await this.db.withTransaction(async (tx) => {
      const event = await this.lockManaged(actor, id, tx);
      if (!isEditableStatus(event.status))
        throw new ConflictError('This event can no longer be edited');
      if (!(await this.seatMaps.categoryBelongsToEvent(id, categoryId, tx))) {
        throw new NotFoundError('Seat category not found');
      }
      await this.seatMaps.updateCategory(id, categoryId, patch, tx);
    });
    return this.get(actor, id);
  }

  /** Moves seats to another category, refusing seats that are currently held or sold. */
  async assignSeats(actor: Actor, id: string, seatIds: string[], categoryId: string) {
    const unique = [...new Set(seatIds)];
    await this.db.withTransaction(async (tx) => {
      const event = await this.lockManaged(actor, id, tx);
      if (!isEditableStatus(event.status))
        throw new ConflictError('This event can no longer be edited');
      if (!(await this.seatMaps.categoryBelongsToEvent(id, categoryId, tx))) {
        throw new NotFoundError('Seat category not found');
      }
      if ((await this.seatMaps.countSeatsInEvent(id, unique, tx)) !== unique.length) {
        throw new NotFoundError('One or more seats were not found in this event');
      }
      if ((await this.seatMaps.countActiveAllocations(unique, tx)) > 0) {
        throw activeBookingsError('reassign seats that are held or sold');
      }
      await this.seatMaps.assignCategory(id, unique, categoryId, tx);
    });
    return this.get(actor, id);
  }

  async publish(actor: Actor, id: string) {
    await this.db.withTransaction(async (tx) => {
      const event = await this.lockManaged(actor, id, tx);
      if (event.status !== 'DRAFT') throw new ConflictError('Only draft events can be published');
      if (event.startAt.getTime() <= this.now().getTime()) {
        throw new ValidationError([
          { path: 'startAt', message: 'Cannot publish an event in the past' },
        ]);
      }
      const categories = await this.seatMaps.listCategories(id, tx);
      if (categories.length === 0 || categories.every((category) => category.totalSeats === 0)) {
        throw new ValidationError([{ path: 'seatMap', message: 'Add seats before publishing' }]);
      }
      await this.events.setStatus(id, 'PUBLISHED', tx);
    });
    return this.get(actor, id);
  }

  async unpublish(actor: Actor, id: string) {
    await this.db.withTransaction(async (tx) => {
      const event = await this.lockManaged(actor, id, tx);
      if (event.status !== 'PUBLISHED')
        throw new ConflictError('Only published events can be unpublished');
      if ((await this.events.countActiveBookings(id, tx)) > 0)
        throw activeBookingsError('unpublish');
      await this.events.setStatus(id, 'DRAFT', tx);
    });
    return this.get(actor, id);
  }

  /** Cancels an event without active bookings (refunding sold events arrives with booking management). */
  async cancel(actor: Actor, id: string) {
    await this.db.withTransaction(async (tx) => {
      const event = await this.lockManaged(actor, id, tx);
      if (!isEditableStatus(event.status))
        throw new ConflictError(`Event is already ${event.status.toLowerCase()}`);
      if ((await this.events.countActiveBookings(id, tx)) > 0) throw activeBookingsError('cancel');
      await this.events.setStatus(id, 'CANCELLED', tx);
    });
    return this.get(actor, id);
  }

  /** Hard delete: drafts (or cancelled events) that never had a booking. */
  async remove(actor: Actor, id: string): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      const event = await this.lockManaged(actor, id, tx);
      if (event.status !== 'DRAFT' && event.status !== 'CANCELLED') {
        throw new ConflictError('Only draft or cancelled events can be deleted');
      }
      if (await this.events.hasBookingHistory(id, tx)) {
        throw new AppError(409, 'RESOURCE_IN_USE', 'Events with booking history cannot be deleted');
      }
      await this.events.delete(id, tx);
    });
  }

  /** Locks the event row and enforces ownership; foreign events answer 404 (IDOR-safe). */
  private async lockManaged(actor: Actor, id: string, tx: Queryable): Promise<EventRecord> {
    const event = await this.events.findById(id, tx, true);
    if (!event || !canManageResource(actor, event.organizerId))
      throw new NotFoundError('Event not found');
    return event;
  }

  private currentPricing(event: EventRecord): PricingConfig {
    return event.pricingStrategy === 'EARLY_BIRD' &&
      event.earlyBirdDeadline &&
      event.earlyBirdDiscountPct
      ? {
          strategy: 'EARLY_BIRD',
          earlyBirdDeadline: event.earlyBirdDeadline,
          discountPct: event.earlyBirdDiscountPct,
        }
      : { strategy: 'BASE' };
  }

  private assertValidSchedule(input: EventDetailsInput): void {
    const problems = validateSchedule(
      {
        startAt: input.startAt,
        endAt: input.endAt ?? null,
        salesStartAt: input.salesStartAt ?? null,
        salesEndAt: input.salesEndAt ?? null,
        pricing: input.pricing,
      },
      this.now(),
    );
    if (problems.length > 0)
      throw new ValidationError(problems.map((message) => ({ path: 'body', message })));
  }

  private assertValidSeatMap(seatMap: SeatMapDefinition): void {
    const problems = validateSeatMap(seatMap);
    if (problems.length > 0) {
      throw new ValidationError(problems.map((message) => ({ path: 'body.seatMap', message })));
    }
  }

  private toWriteInput(
    input: EventDetailsInput,
    size: { rows: number; seatsPerRow: number },
  ): EventWriteInput {
    return {
      venueId: input.venueId,
      title: input.title,
      description: input.description ?? null,
      startAt: input.startAt,
      endAt: input.endAt ?? null,
      pricingStrategy: input.pricing.strategy,
      earlyBirdDeadline:
        input.pricing.strategy === 'EARLY_BIRD' ? input.pricing.earlyBirdDeadline : null,
      earlyBirdDiscountPct:
        input.pricing.strategy === 'EARLY_BIRD' ? input.pricing.discountPct : null,
      currency: this.options.defaultCurrency,
      seatRows: size.rows,
      seatsPerRow: size.seatsPerRow,
      bannerUrl: input.bannerUrl ?? null,
      salesStartAt: input.salesStartAt ?? null,
      salesEndAt: input.salesEndAt ?? null,
    };
  }
}
