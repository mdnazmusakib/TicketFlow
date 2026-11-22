/** Formats integer minor units (e.g. paisa) as a currency string. */
export function formatMoney(minor: number, currency = 'BDT'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(minor / 100);
}

/** Major-unit input (e.g. "1500.50") to integer minor units; NaN when invalid. */
export function toMinorUnits(major: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(major.trim())) return Number.NaN;
  return Math.round(Number(major) * 100);
}

export function toMajorInput(minor: number): string {
  return (minor / 100).toFixed(2);
}

export function formatDateTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

/** ISO instant -> value for <input type="datetime-local"> in the browser's zone. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/** <input type="datetime-local"> value -> ISO instant (UTC). */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
