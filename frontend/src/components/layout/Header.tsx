import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { useAuth } from '../../features/auth/AuthContext';
import { NotificationBell } from '../../features/notifications/NotificationBell';

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

export function Header() {
  const [open, setOpen] = useState(false);
  const { user, status, logout } = useAuth();
  const navigate = useNavigate();

  const items: NavItem[] = [
    { to: '/', label: 'Home', end: true },
    { to: '/events', label: 'Events' },
  ];
  if (user && (user.role === 'ORGANIZER' || user.role === 'ADMIN'))
    items.push({ to: '/organizer', label: 'Organizer' });
  if (user?.role === 'ADMIN') items.push({ to: '/admin', label: 'Admin' });
  if (user?.role === 'CUSTOMER') items.push({ to: '/bookings', label: 'My bookings' });
  if (user)
    items.push({ to: '/account', label: user.role === 'CUSTOMER' ? 'Dashboard' : 'Account' });
  if (status === 'anonymous') {
    items.push({ to: '/login', label: 'Sign in' }, { to: '/register', label: 'Register' });
  }

  async function onLogout() {
    setOpen(false);
    await logout();
    navigate('/');
  }

  return (
    <header className="header">
      <div className="container header__inner">
        <Link to="/" className="brand" onClick={() => setOpen(false)}>
          <span className="brand__mark" aria-hidden="true">
            🎟
          </span>
          TicketFlow
        </Link>
        <button
          type="button"
          className="header__toggle"
          aria-expanded={open}
          aria-controls="primary-nav"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="visually-hidden">Toggle navigation</span>☰
        </button>
        <nav id="primary-nav" className={`nav ${open ? 'nav--open' : ''}`} aria-label="Primary">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}
          {user && <NotificationBell onNavigate={() => setOpen(false)} />}
          {user && (
            <button type="button" className="nav__link link-button" onClick={onLogout}>
              Sign out ({user.name})
            </button>
          )}
        </nav>
      </div>
    </header>
  );
}
