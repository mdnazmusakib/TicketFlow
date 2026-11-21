import { Router } from 'express';
import type { Controllers } from '../container';
import { createHealthRouter } from './health.routes';

/** Mounts every feature router under /api. New features register here. */
export function createApiRouter(controllers: Controllers): Router {
  const router = Router();
  router.use('/health', createHealthRouter(controllers.health));
  return router;
}
