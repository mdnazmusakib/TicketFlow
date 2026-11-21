import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button } from '../../components/ui/Button';
import { FormAlert, TextField } from '../../components/ui/Form';
import { ApiError, toErrorMessage } from '../../lib/apiClient';
import { useAuth } from './AuthContext';

const RESEND_COOLDOWN_SECONDS = 60;

export function VerifyOtpPage() {
  const { verifyOtp, resendOtp } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(
    params.get('email') ? 'We sent a 6-digit code to your email. It expires in 5 minutes.' : null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(params.get('resend') ? 0 : RESEND_COOLDOWN_SECONDS);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    timer.current = setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer.current);
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await verifyOtp(email.trim(), otp.trim());
      navigate(user.role === 'CUSTOMER' ? '/account' : '/organizer', { replace: true });
    } catch (err) {
      setError(toErrorMessage(err));
      if (
        err instanceof ApiError &&
        (err.code === 'OTP_EXPIRED' || err.code === 'OTP_ATTEMPTS_EXCEEDED')
      )
        setOtp('');
    } finally {
      setSubmitting(false);
    }
  }

  async function onResend() {
    setError(null);
    try {
      await resendOtp(email.trim());
      setInfo('If your account is awaiting verification, a new code is on its way.');
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }

  return (
    <div className="auth-layout auth-layout--single">
      <section className="card auth-card">
        <h1>Verify your email</h1>
        <form onSubmit={onSubmit} noValidate>
          <FormAlert message={info} tone="info" />
          <FormAlert message={error} />
          <TextField
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextField
            label="Verification code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
          />
          <Button type="submit" disabled={submitting || otp.length !== 6 || !email}>
            {submitting ? 'Verifying…' : 'Verify'}
          </Button>
        </form>
        <p className="muted">
          Didn&apos;t get it?{' '}
          <button
            type="button"
            className="link-button"
            onClick={onResend}
            disabled={cooldown > 0 || !email}
          >
            {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
          </button>
        </p>
        <p className="muted">
          <Link to="/login">Back to sign in</Link>
        </p>
      </section>
    </div>
  );
}
