import { useEffect, useRef, useState } from 'react';

interface Props {
  expiresAt: string;
  /** Server clock at response time; corrects a skewed browser clock. */
  serverTime: string;
  onExpire?: () => void;
}

function remainingMs(expiresAt: string, offsetMs: number): number {
  return Math.max(0, new Date(expiresAt).getTime() - (Date.now() + offsetMs));
}

export function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Hold countdown (mm:ss). Calls onExpire once when it reaches zero. */
export function Countdown({ expiresAt, serverTime, onExpire }: Props) {
  const [offset] = useState(() => new Date(serverTime).getTime() - Date.now());
  const [left, setLeft] = useState(() => remainingMs(expiresAt, offset));
  const fired = useRef(false);
  const onExpireRef = useRef(onExpire);

  useEffect(() => {
    onExpireRef.current = onExpire;
  });

  useEffect(() => {
    const tick = () => {
      const value = remainingMs(expiresAt, offset);
      setLeft(value);
      if (value === 0 && !fired.current) {
        fired.current = true;
        onExpireRef.current?.();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt, offset]);

  const urgent = left < 60_000;
  return (
    <p
      className={`countdown ${urgent ? 'countdown--urgent' : ''}`}
      role="timer"
      aria-label="Time left to complete your booking"
    >
      <span aria-hidden="true">⏱</span>{' '}
      {left > 0 ? `${formatRemaining(left)} left` : 'Hold expired'}
    </p>
  );
}
