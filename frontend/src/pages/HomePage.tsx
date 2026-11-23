import { Link } from 'react-router';
import { useAuth } from '../features/auth/AuthContext';
import { SystemStatus } from '../features/system/SystemStatus';

export function HomePage() {
  const { user } = useAuth();
  return (
    <>
      <section className="hero">
        <h1>Book tickets for the events you love</h1>
        <p>Real-time seat holds, secure payments and instant confirmations.</p>
        <p className="hero__actions">
          <Link className="btn btn--primary" to="/events">
            Browse events
          </Link>
          {!user && (
            <Link className="btn btn--secondary" to="/register">
              Create an account
            </Link>
          )}
        </p>
      </section>
      <div className="grid">
        <SystemStatus />
      </div>
    </>
  );
}
