import { Router, type RequestHandler } from 'express';
import type { Controllers } from '../container';
import { createAuthRouter } from './auth.routes';
import { createOrganizerRouter, createPublicEventRouter } from './event.routes';
import { createHealthRouter } from './health.routes';

export interface RouteGuards {
  authenticate: RequestHandler;
  authLimiter: RequestHandler;
}

/** Mounts every feature router under /api. New features register here. */
export function createApiRouter(controllers: Controllers, guards: RouteGuards): Router {
  const router = Router();
  router.use('/health', createHealthRouter(controllers.health));
  router.use('/auth', createAuthRouter(controllers.auth, guards));
  router.use('/events', createPublicEventRouter(controllers.publicEvents));
  router.use(
    '/organizer',
    createOrganizerRouter(controllers.venues, controllers.organizerEvents, guards.authenticate),
  );
  return router;
}
