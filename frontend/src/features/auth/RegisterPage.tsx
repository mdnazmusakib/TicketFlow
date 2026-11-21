import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '../../components/ui/Button';
import { FormAlert, SelectField, TextField } from '../../components/ui/Form';
import { fieldErrors, toErrorMessage } from '../../lib/apiClient';
import { useAuth } from './AuthContext';

const PASSWORD_RULES = [
  { test: (v: string) => v.length >= 8, label: 'at least 8 characters' },
  { test: (v: string) => /[a-z]/.test(v), label: 'a lowercase letter' },
  { test: (v: string) => /[A-Z]/.test(v), label: 'an uppercase letter' },
  { test: (v: string) => /\d/.test(v), label: 'a digit' },
  { test: (v: string) => /[^A-Za-z0-9]/.test(v), label: 'a symbol' },
];

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'CUSTOMER' as 'CUSTOMER' | 'ORGANIZER',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const missingRules = PASSWORD_RULES.filter((rule) => !rule.test(form.password)).map(
    (rule) => rule.label,
  );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (missingRules.length > 0) {
      setErrors({ password: `Password needs ${missingRules.join(', ')}` });
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const result = await register({ ...form, name: form.name.trim(), email: form.email.trim() });
      if (result.verificationRequired) {
        navigate(`/verify-email?email=${encodeURIComponent(result.user.email)}`);
      } else {
        navigate(result.user.role === 'ORGANIZER' ? '/organizer' : '/account', { replace: true });
      }
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(toErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const update = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: e.target.value }));

  return (
    <div className="auth-layout auth-layout--single">
      <section className="card auth-card">
        <h1>Create your account</h1>
        <form onSubmit={onSubmit} noValidate>
          <FormAlert message={error} />
          <TextField
            label="Full name"
            autoComplete="name"
            required
            value={form.name}
            onChange={update('name')}
            error={errors.name}
          />
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={update('email')}
            error={errors.email}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            required
            value={form.password}
            onChange={update('password')}
            error={errors.password}
            hint={missingRules.length ? `Needs ${missingRules.join(', ')}` : 'Strong password'}
          />
          <SelectField
            label="I want to"
            value={form.role}
            onChange={update('role')}
            options={[
              { value: 'CUSTOMER', label: 'Book tickets (Customer)' },
              { value: 'ORGANIZER', label: 'Sell tickets for my events (Organizer)' },
            ]}
          />
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating account…' : 'Create account'}
          </Button>
        </form>
        <p className="muted">
          Already registered? <Link to="/login">Sign in</Link>
        </p>
      </section>
    </div>
  );
}
