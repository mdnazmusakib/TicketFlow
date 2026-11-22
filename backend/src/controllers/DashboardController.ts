import type { Request, Response } from 'express';
import type { z } from 'zod';
import { getAuth } from '../middlewares/auth';
import { getValidated } from '../middlewares/validate';
import type {
  adminUsersQuerySchema,
  eventBookingsQuerySchema,
  notificationListSchema,
} from '../schemas/dashboard.schemas';
import type { idParamsSchema } from '../schemas/event.schemas';
import type { DashboardService } from '../services/dashboard/DashboardService';
import type { NotificationInboxService } from '../services/notifications/NotificationInboxService';
import { sendSuccess } from '../shared/http/apiResponse';

type IdParams = z.output<typeof idParamsSchema>;

/** In-app notification inbox endpoints (always scoped to the signed-in user). */
export class NotificationController {
  constructor(private readonly inbox: NotificationInboxService) {}

  list = async (req: Request, res: Response) => {
    const { query } = getValidated<{ query: z.output<typeof notificationListSchema> }>(req);
    const { items, meta } = await this.inbox.list(getAuth(req).actor, query);
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, items, 200, meta);
  };

  unreadCount = async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, await this.inbox.unreadCount(getAuth(req).actor));
  };

  markRead = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    sendSuccess(res, await this.inbox.markRead(getAuth(req).actor, params.id));
  };

  markAllRead = async (req: Request, res: Response) => {
    sendSuccess(res, await this.inbox.markAllRead(getAuth(req).actor));
  };
}

/** Dashboard read models (customer, organizer, admin). */
export class DashboardController {
  constructor(private readonly dashboards: DashboardService) {}

  customer = async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, await this.dashboards.customer(getAuth(req).actor));
  };

  organizer = async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, await this.dashboards.organizer(getAuth(req).actor));
  };

  eventOverview = async (req: Request, res: Response) => {
    const { params, query } = getValidated<{
      params: IdParams;
      query: z.output<typeof eventBookingsQuerySchema>;
    }>(req);
    const { meta, ...data } = await this.dashboards.eventOverview(
      getAuth(req).actor,
      params.id,
      query,
    );
    sendSuccess(res, data, 200, meta);
  };

  admin = async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, await this.dashboards.admin(getAuth(req).actor));
  };

  adminUsers = async (req: Request, res: Response) => {
    const { query } = getValidated<{ query: z.output<typeof adminUsersQuerySchema> }>(req);
    const { items, meta } = await this.dashboards.adminUsers(getAuth(req).actor, query);
    sendSuccess(res, items, 200, meta);
  };
}
