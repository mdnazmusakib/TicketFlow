import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button } from '../../components/ui/Button';
import { FormAlert, TextField } from '../../components/ui/Form';
import { ApiError, toErrorMessage } from '../../lib/apiClient';
import { useAuth } from './AuthContext';
import { safeNextPath } from './ProtectedRoute';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await login(email.trim(), password);
      const fallback = user.role === 'CUSTOMER' ? '/account' : '/organizer';
      navigate(safeNextPath(params.get('next'), fallback), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED') {
        navigate(`/verify-email?email=${encodeURIComponent(email.trim())}&resend=1`);
        return;
      }
      setError(toErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-layout">
      <section className="card auth-card">
        <h1>Sign in</h1>
        <form onSubmit={onSubmit} noValidate>
          <FormAlert message={error} />
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" disabled={submitting || !email || !password}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        <p className="muted">
          New here? <Link to="/register">Create an account</Link>
        </p>
      </section>
    </div>
  );
}
