import { Router, type RequestHandler } from 'express';
import type {
  DashboardController,
  NotificationController,
} from '../controllers/DashboardController';
import { requireRole } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import {
  adminUsersQuerySchema,
  eventBookingsQuerySchema,
  financeQuerySchema,
  notificationListSchema,
} from '../schemas/dashboard.schemas';
import { idParamsSchema } from '../schemas/event.schemas';

/** /api/notifications — the signed-in user's in-app inbox. */
export function createNotificationRouter(
  controller: NotificationController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  router.get('/', validate({ query: notificationListSchema }), controller.list);
  router.get('/unread-count', controller.unreadCount);
  router.post('/read-all', controller.markAllRead);
  router.post('/:id/read', validate({ params: idParamsSchema }), controller.markRead);
  return router;
}

/** /api/dashboard — role-specific dashboards. */
export function createDashboardRouter(
  controller: DashboardController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  router.get('/customer', controller.customer);
  router.get('/organizer', requireRole('ORGANIZER', 'ADMIN'), controller.organizer);
  router.get(
    '/organizer/events/:id',
    requireRole('ORGANIZER', 'ADMIN'),
    validate({ params: idParamsSchema, query: eventBookingsQuerySchema }),
    controller.eventOverview,
  );
  return router;
}

/** /api/admin — platform oversight; ADMIN only (enforced here and in the service). */
export function createAdminRouter(
  controller: DashboardController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate, requireRole('ADMIN'));
  router.get('/overview', controller.admin);
  router.get('/users', validate({ query: adminUsersQuerySchema }), controller.adminUsers);
  router.get('/diagnostics/request', controller.requestDiagnostics);
  router.get('/finance', validate({ query: financeQuerySchema }), controller.adminFinance);
  return router;
}
