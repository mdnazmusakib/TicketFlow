import { Router, type RequestHandler } from 'express';
import type {
  OrganizerEventController,
  PublicEventController,
  VenueController,
} from '../controllers/EventController';
import { requireRole } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import {
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

const byId = validate({ params: idParamsSchema });

/** /api/events — public catalogue. */
export function createPublicEventRouter(controller: PublicEventController): Router {
  const router = Router();
  router.get('/', validate({ query: publicEventQuerySchema }), controller.search);
  router.get('/cities', controller.cities);
  router.get('/:id', byId, controller.details);
  router.get('/:id/seats', byId, controller.availability);
  return router;
}

/** /api/organizer — venues and events of the signed-in organizer (ADMIN sees all). */
export function createOrganizerRouter(
  venues: VenueController,
  events: OrganizerEventController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate, requireRole('ORGANIZER', 'ADMIN'));

  router.get('/venues', venues.list);
  router.post('/venues', validate({ body: venueSchema }), venues.create);
  router.get('/venues/:id', byId, venues.get);
  router.patch(
    '/venues/:id',
    validate({ params: idParamsSchema, body: updateVenueSchema }),
    venues.update,
  );
  router.delete('/venues/:id', byId, venues.remove);

  router.get('/events', validate({ query: organizerEventListSchema }), events.list);
  router.post('/events', validate({ body: createEventSchema }), events.create);
  router.get('/events/:id', byId, events.get);
  router.patch(
    '/events/:id',
    validate({ params: idParamsSchema, body: updateEventSchema }),
    events.update,
  );
  router.delete('/events/:id', byId, events.remove);
  router.put(
    '/events/:id/seat-map',
    validate({ params: idParamsSchema, body: seatMapSchema }),
    events.replaceSeatMap,
  );
  router.patch(
    '/events/:id/categories/:categoryId',
    validate({ params: categoryParamsSchema, body: updateCategorySchema }),
    events.updateCategory,
  );
  router.patch(
    '/events/:id/seats/category',
    validate({ params: idParamsSchema, body: assignSeatsSchema }),
    events.assignSeats,
  );
  router.post('/events/:id/publish', byId, events.publish);
  router.post('/events/:id/unpublish', byId, events.unpublish);
  router.post('/events/:id/cancel', byId, events.cancel);
  return router;
}
