import type { Actor } from '../../domain/auth/roles';
import type {
  NotificationRecord,
  NotificationRepository,
} from '../../repositories/NotificationRepository';
import { NotFoundError } from '../../shared/errors/AppError';
import { buildPaginationMeta } from '../../shared/http/apiResponse';

export function toInboxDto(notification: NotificationRecord) {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    bookingId: notification.bookingId,
    isRead: notification.isRead,
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
  };
}

/** The signed-in user's in-app notifications. Every query is scoped to actor.id. */
export class NotificationInboxService {
  constructor(private readonly notifications: NotificationRepository) {}

  async list(actor: Actor, filter: { unreadOnly: boolean; page: number; pageSize: number }) {
    const [{ items, total }, unreadCount] = await Promise.all([
      this.notifications.listInbox(actor.id, filter),
      this.notifications.unreadCount(actor.id),
    ]);
    return {
      items: items.map(toInboxDto),
      meta: { ...buildPaginationMeta(filter.page, filter.pageSize, total), unreadCount },
    };
  }

  async unreadCount(actor: Actor): Promise<{ unreadCount: number }> {
    return { unreadCount: await this.notifications.unreadCount(actor.id) };
  }

  async markRead(actor: Actor, id: string) {
    const updated = await this.notifications.markRead(actor.id, id);
    // Someone else's notification looks exactly like a missing one.
    if (!updated) throw new NotFoundError('Notification not found');
    return toInboxDto(updated);
  }

  async markAllRead(actor: Actor): Promise<{ updated: number; unreadCount: number }> {
    const updated = await this.notifications.markAllRead(actor.id);
    return { updated, unreadCount: 0 };
  }
}
