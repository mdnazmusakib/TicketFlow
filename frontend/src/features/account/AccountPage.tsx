import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../../lib/format';

/** Signed-in user's profile (customer area; bookings join it in a later phase). */
export function AccountPage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <section className="card">
      <h1>My account</h1>
      <dl className="details">
        <dt>Name</dt>
        <dd>{user.name}</dd>
        <dt>Email</dt>
        <dd>{user.email}</dd>
        <dt>Role</dt>
        <dd>{user.role}</dd>
        <dt>Member since</dt>
        <dd>{formatDateTime(user.createdAt)}</dd>
      </dl>
      <p>
        <Link className="btn btn--primary" to="/events">
          Browse events
        </Link>
      </p>
    </section>
  );
}
