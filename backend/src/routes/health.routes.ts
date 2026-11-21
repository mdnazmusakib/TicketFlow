import { Router } from 'express';
import type { HealthController } from '../controllers/HealthController';

export function createHealthRouter(controller: HealthController): Router {
  const router = Router();
  /** Liveness: process is up. Never touches dependencies. */
  router.get('/live', controller.live);
  /** Readiness: PostgreSQL + Redis reachable. 503 when any dependency is down. */
  router.get('/ready', controller.ready);
  router.get('/', controller.ready);
  return router;
}
