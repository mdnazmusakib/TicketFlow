import { useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import {
  notificationsApi as defaultApi,
  NOTIFICATIONS_CHANGED,
  type NotificationsApi,
} from './notificationsApi';

const POLL_MS = 30_000;

/** Header link to the inbox with a live unread badge (polls; refreshes on inbox changes). */
export function NotificationBell({
  api = defaultApi,
  onNavigate,
}: {
  api?: NotificationsApi;
  onNavigate?: () => void;
}) {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let controller = new AbortController();
    const load = () => {
      controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      api.unreadCount(signal).then(
        (count) => {
          if (!signal.aborted) setUnread(count);
        },
        () => undefined, // Badge is best-effort; the inbox page shows real errors.
      );
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    window.addEventListener(NOTIFICATIONS_CHANGED, load);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_CHANGED, load);
    };
  }, [api]);

  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
  return (
    <NavLink
      to="/notifications"
      aria-label={label}
      className={({ isActive }) => `nav__link nav__bell ${isActive ? 'nav__link--active' : ''}`}
      onClick={onNavigate}
    >
      <span aria-hidden="true">🔔</span>
      <span aria-hidden="true">Notifications</span>
      {unread > 0 && (
        <span className="nav__count" aria-hidden="true">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </NavLink>
  );
}
