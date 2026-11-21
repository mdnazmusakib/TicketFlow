import { apiClient, type ApiClient } from '../../lib/apiClient';
import type {
  EventDetails,
  EventDetailsInput,
  EventStatus,
  ManagedEvent,
  ManagedEventDetails,
  PageMeta,
  PublicEvent,
  SeatAvailability,
  SeatMapInput,
  Venue,
  VenueInput,
} from './types';

export interface EventSearchParams {
  q?: string;
  city?: string;
  from?: string;
  to?: string;
  sort?: 'date' | 'price' | 'title' | 'newest';
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export function createEventsApi(client: ApiClient = apiClient) {
  return {
    async search(params: EventSearchParams, signal?: AbortSignal) {
      const { data, meta } = await client.get<PublicEvent[]>('/events', {
        query: { ...params },
        signal,
      });
      return { items: data, meta: meta as unknown as PageMeta };
    },
    async cities(signal?: AbortSignal) {
      return (await client.get<string[]>('/events/cities', { signal })).data;
    },
    async details(id: string, signal?: AbortSignal) {
      return (await client.get<EventDetails>(`/events/${encodeURIComponent(id)}`, { signal })).data;
    },
    async availability(id: string, signal?: AbortSignal) {
      return (
        await client.get<SeatAvailability>(`/events/${encodeURIComponent(id)}/seats`, { signal })
      ).data;
    },
  };
}

export function createOrganizerApi(client: ApiClient = apiClient) {
  const base = '/organizer';
  const eventPath = (id: string) => `${base}/events/${encodeURIComponent(id)}`;
  return {
    async listVenues(signal?: AbortSignal) {
      return (await client.get<Venue[]>(`${base}/venues`, { signal })).data;
    },
    async createVenue(input: VenueInput) {
      return (await client.post<Venue>(`${base}/venues`, input)).data;
    },
    async updateVenue(id: string, input: Partial<VenueInput>) {
      return (await client.patch<Venue>(`${base}/venues/${encodeURIComponent(id)}`, input)).data;
    },
    async deleteVenue(id: string) {
      await client.delete(`${base}/venues/${encodeURIComponent(id)}`);
    },
    async listEvents(
      params: { status?: EventStatus; page?: number; pageSize?: number },
      signal?: AbortSignal,
    ) {
      const { data, meta } = await client.get<ManagedEvent[]>(`${base}/events`, {
        query: { ...params },
        signal,
      });
      return { items: data, meta: meta as unknown as PageMeta };
    },
    async getEvent(id: string, signal?: AbortSignal) {
      return (await client.get<ManagedEventDetails>(eventPath(id), { signal })).data;
    },
    async createEvent(input: EventDetailsInput & { seatMap: SeatMapInput }) {
      return (await client.post<ManagedEventDetails>(`${base}/events`, input)).data;
    },
    async updateEvent(id: string, input: Partial<EventDetailsInput>) {
      return (await client.patch<ManagedEventDetails>(eventPath(id), input)).data;
    },
    async replaceSeatMap(id: string, seatMap: SeatMapInput) {
      return (await client.put<ManagedEventDetails>(`${eventPath(id)}/seat-map`, seatMap)).data;
    },
    async updateCategory(
      id: string,
      categoryId: string,
      patch: { name?: string; priceMinor?: number },
    ) {
      return (
        await client.patch<ManagedEventDetails>(
          `${eventPath(id)}/categories/${encodeURIComponent(categoryId)}`,
          patch,
        )
      ).data;
    },
    async assignSeats(id: string, seatIds: string[], categoryId: string) {
      return (
        await client.patch<ManagedEventDetails>(`${eventPath(id)}/seats/category`, {
          seatIds,
          categoryId,
        })
      ).data;
    },
    async transition(id: string, action: 'publish' | 'unpublish' | 'cancel') {
      return (await client.post<ManagedEventDetails>(`${eventPath(id)}/${action}`)).data;
    },
    async deleteEvent(id: string) {
      await client.delete(eventPath(id));
    },
  };
}

export type EventsApi = ReturnType<typeof createEventsApi>;
export type OrganizerApi = ReturnType<typeof createOrganizerApi>;
export const eventsApi = createEventsApi();
export const organizerApi = createOrganizerApi();
