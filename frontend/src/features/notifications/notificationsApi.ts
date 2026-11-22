import { apiClient, type ApiClient } from '../../lib/apiClient';
import type { PageMeta } from '../events/types';

export type NotificationType = 'BOOKING_CONFIRMED' | 'BOOKING_CANCELLED' | 'EVENT_REMINDER_1H';

export interface InAppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  bookingId: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  items: InAppNotification[];
  meta: PageMeta & { unreadCount: number };
}

/** Fired after the inbox changes so the header badge refreshes immediately. */
export const NOTIFICATIONS_CHANGED = 'tf:notifications-changed';

export function announceNotificationsChanged(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
}

export function createNotificationsApi(client: ApiClient = apiClient) {
  return {
    async list(
      params: { unreadOnly?: boolean; page?: number; pageSize?: number },
      signal?: AbortSignal,
    ): Promise<NotificationPage> {
      const { data, meta } = await client.get<InAppNotification[]>('/notifications', {
        query: {
          page: params.page,
          pageSize: params.pageSize,
          ...(params.unreadOnly ? { unreadOnly: 'true' } : {}),
        },
        signal,
      });
      return { items: data, meta: meta as unknown as NotificationPage['meta'] };
    },
    async unreadCount(signal?: AbortSignal): Promise<number> {
      const { data } = await client.get<{ unreadCount: number }>('/notifications/unread-count', {
        signal,
      });
      return typeof data?.unreadCount === 'number' ? data.unreadCount : 0;
    },
    async markRead(id: string) {
      return (await client.post<InAppNotification>(`/notifications/${encodeURIComponent(id)}/read`))
        .data;
    },
    async markAllRead() {
      return (
        await client.post<{ updated: number; unreadCount: number }>('/notifications/read-all')
      ).data;
    },
  };
}

export type NotificationsApi = ReturnType<typeof createNotificationsApi>;
export const notificationsApi = createNotificationsApi();

export const NOTIFICATION_LABEL: Record<NotificationType, string> = {
  BOOKING_CONFIRMED: 'Booking confirmed',
  BOOKING_CANCELLED: 'Booking cancelled',
  EVENT_REMINDER_1H: 'Event reminder',
};
