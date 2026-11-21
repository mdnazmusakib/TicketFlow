import type { Request, Response } from 'express';
import type { z } from 'zod';
import { getAuth } from '../middlewares/auth';
import { getValidated } from '../middlewares/validate';
import type {
  assignSeatsSchema,
  categoryParamsSchema,
  createEventSchema,
  idParamsSchema,
  organizerEventListSchema,
  publicEventQuerySchema,
  seatMapSchema,
  updateCategorySchema,
  updateEventSchema,
  updateVenueSchema,
  venueSchema,
} from '../schemas/event.schemas';
import type { EventDiscoveryService } from '../services/events/EventDiscoveryService';
import type { EventService } from '../services/events/EventService';
import type { VenueService } from '../services/events/VenueService';
import { sendSuccess } from '../shared/http/apiResponse';

type IdParams = z.output<typeof idParamsSchema>;

/** Organizer venue endpoints (HTTP only). */
export class VenueController {
  constructor(private readonly venues: VenueService) {}

  list = async (req: Request, res: Response) => {
    sendSuccess(res, await this.venues.list(getAuth(req).actor));
  };

  get = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    sendSuccess(res, await this.venues.get(getAuth(req).actor, params.id));
  };

  create = async (req: Request, res: Response) => {
    const body = req.body as z.output<typeof venueSchema>;
    sendSuccess(res, await this.venues.create(getAuth(req).actor, body), 201);
  };

  update = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    const body = req.body as z.output<typeof updateVenueSchema>;
    sendSuccess(res, await this.venues.update(getAuth(req).actor, params.id, body));
  };

  remove = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    await this.venues.remove(getAuth(req).actor, params.id);
    res.status(204).end();
  };
}

/** Organizer event endpoints (HTTP only). */
export class OrganizerEventController {
  constructor(private readonly events: EventService) {}

  list = async (req: Request, res: Response) => {
    const { query } = getValidated<{ query: z.output<typeof organizerEventListSchema> }>(req);
    const { items, meta } = await this.events.list(getAuth(req).actor, query);
    sendSuccess(res, items, 200, meta);
  };

  get = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    sendSuccess(res, await this.events.get(getAuth(req).actor, params.id));
  };

  create = async (req: Request, res: Response) => {
    const body = req.body as z.output<typeof createEventSchema>;
    sendSuccess(res, await this.events.create(getAuth(req).actor, body), 201);
  };

  update = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    const body = req.body as z.output<typeof updateEventSchema>;
    sendSuccess(res, await this.events.update(getAuth(req).actor, params.id, body));
  };

  replaceSeatMap = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    const body = req.body as z.output<typeof seatMapSchema>;
    sendSuccess(res, await this.events.replaceSeatMap(getAuth(req).actor, params.id, body));
  };

  updateCategory = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: z.output<typeof categoryParamsSchema> }>(req);
    const body = req.body as z.output<typeof updateCategorySchema>;
    sendSuccess(
      res,
      await this.events.updateCategory(getAuth(req).actor, params.id, params.categoryId, body),
    );
  };

  assignSeats = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    const body = req.body as z.output<typeof assignSeatsSchema>;
    sendSuccess(
      res,
      await this.events.assignSeats(getAuth(req).actor, params.id, body.seatIds, body.categoryId),
    );
  };

  publish = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    sendSuccess(res, await this.events.publish(getAuth(req).actor, params.id));
  };

  unpublish = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    sendSuccess(res, await this.events.unpublish(getAuth(req).actor, params.id));
  };

  cancel = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    sendSuccess(res, await this.events.cancel(getAuth(req).actor, params.id));
  };

  remove = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    await this.events.remove(getAuth(req).actor, params.id);
    res.status(204).end();
  };
}

/** Public catalogue endpoints (no authentication). */
export class PublicEventController {
  constructor(private readonly discovery: EventDiscoveryService) {}

  search = async (req: Request, res: Response) => {
    const { query } = getValidated<{ query: z.output<typeof publicEventQuerySchema> }>(req);
    const { items, meta } = await this.discovery.search(query);
    sendSuccess(res, items, 200, meta);
  };

  cities = async (_req: Request, res: Response) => {
    sendSuccess(res, await this.discovery.cities());
  };

  details = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    sendSuccess(res, await this.discovery.details(params.id));
  };

  availability = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, await this.discovery.availability(params.id));
  };
}
