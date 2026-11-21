import type { EventRepository, PublicEventQuery } from '../../repositories/EventRepository';
import type { SeatMapRepository } from '../../repositories/SeatMapRepository';
import { NotFoundError } from '../../shared/errors/AppError';
import { buildPaginationMeta } from '../../shared/http/apiResponse';
import { toCategoryDto, toPublicEventDto, toSeatDto } from './eventDto';

/** Public, read-only catalogue: only PUBLISHED upcoming events are visible. */
export class EventDiscoveryService {
  constructor(
    private readonly events: EventRepository,
    private readonly seatMaps: SeatMapRepository,
  ) {}

  async search(query: PublicEventQuery) {
    const { items, total } = await this.events.searchPublic(query);
    return {
      items: items.map(toPublicEventDto),
      meta: buildPaginationMeta(query.page, query.pageSize, total),
    };
  }

  cities(): Promise<string[]> {
    return this.events.listPublicCities();
  }

  async details(id: string) {
    const event = await this.events.findWithStats(id);
    if (!event || event.status !== 'PUBLISHED') throw new NotFoundError('Event not found');
    const categories = await this.seatMaps.listCategories(id);
    return { ...toPublicEventDto(event), categories: categories.map(toCategoryDto) };
  }

  async availability(id: string) {
    const event = await this.events.findById(id);
    if (!event || event.status !== 'PUBLISHED') throw new NotFoundError('Event not found');
    const [categories, seats] = await Promise.all([
      this.seatMaps.listCategories(id),
      this.seatMaps.listSeats(id),
    ]);
    return {
      eventId: id,
      seatMap: { rows: event.seatRows, seatsPerRow: event.seatsPerRow },
      categories: categories.map(toCategoryDto),
      seats: seats.map(toSeatDto),
    };
  }
}
