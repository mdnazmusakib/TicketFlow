import type { Seat, SeatCategory } from './types';

interface Props {
  seats: Seat[];
  categories: SeatCategory[];
  selected?: ReadonlySet<string>;
  onToggle?: (seat: Seat) => void;
  /** Organizer mode: every seat is clickable regardless of availability. */
  editable?: boolean;
}

const PALETTE = [
  '#6366f1',
  '#0ea5e9',
  '#22c55e',
  '#f59e0b',
  '#ec4899',
  '#14b8a6',
  '#a855f7',
  '#ef4444',
  '#84cc16',
  '#64748b',
];

export function categoryColor(categories: SeatCategory[], categoryId: string): string {
  const index = categories.findIndex((category) => category.id === categoryId);
  return PALETTE[(index >= 0 ? index : 0) % PALETTE.length]!;
}

/** Seat map grid shared by the public details page and the organizer editor. */
export function SeatGrid({ seats, categories, selected, onToggle, editable = false }: Props) {
  const rows = new Map<string, Seat[]>();
  for (const seat of seats) rows.set(seat.row, [...(rows.get(seat.row) ?? []), seat]);

  return (
    <div className="seat-grid" role="grid" aria-label="Seat map">
      <div className="seat-grid__stage">Stage</div>
      {[...rows.entries()].map(([row, rowSeats]) => (
        <div className="seat-grid__row" role="row" key={row}>
          <span className="seat-grid__label" aria-hidden="true">
            {row}
          </span>
          {rowSeats.map((seat) => {
            const unavailable = seat.status === 'UNAVAILABLE';
            const isSelected = selected?.has(seat.id) ?? false;
            const interactive = Boolean(onToggle) && (editable || !unavailable);
            return (
              <button
                key={seat.id}
                type="button"
                role="gridcell"
                className={`seat ${unavailable ? 'seat--unavailable' : ''} ${isSelected ? 'seat--selected' : ''}`}
                style={{ borderColor: categoryColor(categories, seat.categoryId) }}
                aria-label={`Row ${seat.row} seat ${seat.number}${unavailable ? ', unavailable' : ''}`}
                aria-pressed={onToggle ? isSelected : undefined}
                disabled={!interactive}
                onClick={() => onToggle?.(seat)}
              >
                {seat.number}
              </button>
            );
          })}
        </div>
      ))}
      <ul className="seat-legend">
        {categories.map((category) => (
          <li key={category.id}>
            <span
              className="seat-legend__swatch"
              style={{ background: categoryColor(categories, category.id) }}
            />
            {category.name}
          </li>
        ))}
        <li>
          <span className="seat-legend__swatch seat-legend__swatch--unavailable" />
          Unavailable
        </li>
      </ul>
    </div>
  );
}
