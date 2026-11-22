import type { ReactNode } from 'react';

export interface Stat {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}

/** Responsive row of headline numbers (definition list for screen readers). */
export function StatGrid({ stats, label }: { stats: Stat[]; label: string }) {
  return (
    <dl className="stat-grid" aria-label={label}>
      {stats.map((stat) => (
        <div key={stat.label} className="stat">
          <dt className="stat__label">{stat.label}</dt>
          <dd className="stat__value">{stat.value}</dd>
          {stat.hint && <dd className="stat__hint">{stat.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** Compact "STATUS: n" chips for status breakdowns; renders nothing meaningful when empty. */
export function StatusCounts({
  counts,
  label,
  empty = 'None yet',
}: {
  counts: Partial<Record<string, number>>;
  label: string;
  empty?: string;
}) {
  const entries = Object.entries(counts).filter(([, n]) => (n ?? 0) > 0);
  if (entries.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="chips chips--static" aria-label={label}>
      {entries.map(([status, n]) => (
        <li key={status} className="chip chip--static">
          {status.replace(/_/g, ' ').toLowerCase()}: <strong>{n}</strong>
        </li>
      ))}
    </ul>
  );
}
