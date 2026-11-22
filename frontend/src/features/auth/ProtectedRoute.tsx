import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { Spinner } from '../../components/ui/Spinner';
import type { Role } from './authApi';
import { useAuth } from './AuthContext';

interface Props {
  roles?: Role[];
  children?: ReactNode;
}

/**
 * UX guard only: hides pages the user cannot use and redirects to login.
 * The API independently rejects unauthorized requests (401/403/404).
 */
export function ProtectedRoute({ roles, children }: Props) {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <Spinner label="Checking your session" />;
  if (!user) {
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  }
  if (roles && !roles.includes(user.role)) {
    return (
      <div className="error-state" role="alert">
        <h1>Access denied</h1>
        <p>Your account does not have access to this area.</p>
      </div>
    );
  }
  return children ?? <Outlet />;
}

/** Only allows same-origin relative paths as post-login redirects (no open redirect). */
export function safeNextPath(next: string | null, fallback = '/'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\'))
    return fallback;
  return next;
}
