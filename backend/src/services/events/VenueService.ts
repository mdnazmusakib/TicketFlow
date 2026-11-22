import { canManageResource, type Actor } from '../../domain/auth/roles';
import type { VenueInput, VenueRecord, VenueRepository } from '../../repositories/VenueRepository';
import { AppError, ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import { toVenueDto } from './eventDto';

export class VenueService {
  constructor(private readonly venues: VenueRepository) {}

  async list(actor: Actor) {
    const venues = await this.venues.list(actor.role === 'ADMIN' ? null : actor.id);
    return venues.map(toVenueDto);
  }

  async get(actor: Actor, id: string) {
    return toVenueDto(await this.loadManaged(actor, id));
  }

  async create(actor: Actor, input: VenueInput) {
    if (actor.role !== 'ORGANIZER') throw new ForbiddenError('Only organizers can create venues');
    return toVenueDto(await this.venues.create(actor.id, input));
  }

  async update(actor: Actor, id: string, patch: Partial<VenueInput>) {
    await this.loadManaged(actor, id);
    const updated = await this.venues.update(id, patch);
    if (!updated) throw new NotFoundError('Venue not found');
    return toVenueDto(updated);
  }

  async remove(actor: Actor, id: string): Promise<void> {
    await this.loadManaged(actor, id);
    if ((await this.venues.countEvents(id)) > 0) {
      throw new AppError(409, 'RESOURCE_IN_USE', 'Venue is used by events and cannot be deleted');
    }
    await this.venues.delete(id);
  }

  /**
   * Loads a venue the actor may manage. Someone else's venue answers 404 —
   * the same as a missing one — so ids cannot be probed (IDOR-safe).
   */
  async loadManaged(actor: Actor, id: string): Promise<VenueRecord> {
    const venue = await this.venues.findById(id);
    if (!venue || !canManageResource(actor, venue.organizerId))
      throw new NotFoundError('Venue not found');
    return venue;
  }
}
