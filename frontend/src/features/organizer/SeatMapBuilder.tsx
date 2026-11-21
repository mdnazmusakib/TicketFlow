import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/Form';
import { toMinorUnits } from '../../lib/format';
import { rowLabel, type SeatMapInput } from '../events/types';

/** Form state for the builder: prices kept as major-unit strings while typing. */
export interface SeatMapDraft {
  rows: string;
  seatsPerRow: string;
  categories: { name: string; price: string; rows: string[] }[];
}

export const DEFAULT_SEAT_MAP_DRAFT: SeatMapDraft = {
  rows: '5',
  seatsPerRow: '10',
  categories: [
    { name: 'VIP', price: '2500.00', rows: ['A'] },
    { name: 'Regular', price: '1000.00', rows: ['B', 'C', 'D', 'E'] },
  ],
};

/** Validates and converts a draft into the API payload (mirrors server rules). */
export function buildSeatMap(draft: SeatMapDraft): { value?: SeatMapInput; errors: string[] } {
  const errors: string[] = [];
  const rows = Number(draft.rows);
  const seatsPerRow = Number(draft.seatsPerRow);
  if (!Number.isInteger(rows) || rows < 1 || rows > 52)
    errors.push('Rows must be between 1 and 52');
  if (!Number.isInteger(seatsPerRow) || seatsPerRow < 1 || seatsPerRow > 100) {
    errors.push('Seats per row must be between 1 and 100');
  }
  if (draft.categories.length === 0) errors.push('Add at least one category');
  if (errors.length > 0) return { errors };

  const labels = Array.from({ length: rows }, (_, i) => rowLabel(i));
  const assigned = new Map<string, string>();
  const names = new Set<string>();
  const categories = draft.categories.map((category, index) => {
    const name = category.name.trim();
    const priceMinor = toMinorUnits(category.price);
    if (!name) errors.push(`Category ${index + 1} needs a name`);
    if (names.has(name.toLowerCase())) errors.push(`Duplicate category name "${name}"`);
    names.add(name.toLowerCase());
    if (Number.isNaN(priceMinor))
      errors.push(`Category "${name || index + 1}" needs a valid price (e.g. 1500 or 1500.50)`);
    const rowsInMap = category.rows.filter((row) => labels.includes(row));
    if (rowsInMap.length === 0) errors.push(`Category "${name || index + 1}" has no rows`);
    for (const row of rowsInMap) {
      if (assigned.has(row)) errors.push(`Row ${row} is in more than one category`);
      assigned.set(row, name);
    }
    return { name, priceMinor, rows: rowsInMap };
  });
  const missing = labels.filter((row) => !assigned.has(row));
  if (missing.length > 0) errors.push(`Assign a category to rows: ${missing.join(', ')}`);
  return errors.length > 0 ? { errors } : { value: { rows, seatsPerRow, categories }, errors };
}

interface Props {
  draft: SeatMapDraft;
  onChange: (draft: SeatMapDraft) => void;
}

/** Visual seat map editor: grid size + categories, with click-to-assign rows. */
export function SeatMapBuilder({ draft, onChange }: Props) {
  const rows = Math.min(Math.max(Number(draft.rows) || 0, 0), 52);
  const labels = Array.from({ length: rows }, (_, i) => rowLabel(i));
  const { errors } = buildSeatMap(draft);

  const updateCategory = (index: number, patch: Partial<SeatMapDraft['categories'][number]>) =>
    onChange({
      ...draft,
      categories: draft.categories.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });

  const toggleRow = (index: number, row: string) => {
    // A row belongs to exactly one category: assigning it here removes it elsewhere.
    onChange({
      ...draft,
      categories: draft.categories.map((c, i) => {
        if (i === index)
          return {
            ...c,
            rows: c.rows.includes(row) ? c.rows.filter((r) => r !== row) : [...c.rows, row],
          };
        return { ...c, rows: c.rows.filter((r) => r !== row) };
      }),
    });
  };

  return (
    <fieldset className="seat-builder">
      <legend>Seat map</legend>
      <div className="form-row">
        <TextField
          label="Rows (A–AZ)"
          type="number"
          min={1}
          max={52}
          value={draft.rows}
          onChange={(e) => onChange({ ...draft, rows: e.target.value })}
        />
        <TextField
          label="Seats per row"
          type="number"
          min={1}
          max={100}
          value={draft.seatsPerRow}
          onChange={(e) => onChange({ ...draft, seatsPerRow: e.target.value })}
        />
      </div>

      {draft.categories.map((category, index) => (
        <div className="seat-builder__category" key={index}>
          <div className="form-row">
            <TextField
              label={`Category ${index + 1} name`}
              value={category.name}
              onChange={(e) => updateCategory(index, { name: e.target.value })}
            />
            <TextField
              label="Price (major units)"
              inputMode="decimal"
              value={category.price}
              onChange={(e) => updateCategory(index, { price: e.target.value })}
            />
            <Button
              variant="ghost"
              disabled={draft.categories.length === 1}
              onClick={() =>
                onChange({ ...draft, categories: draft.categories.filter((_, i) => i !== index) })
              }
            >
              Remove
            </Button>
          </div>
          <div
            className="chips"
            role="group"
            aria-label={`Rows for ${category.name || `category ${index + 1}`}`}
          >
            {labels.map((row) => (
              <button
                type="button"
                key={row}
                className={`chip ${category.rows.includes(row) ? 'chip--on' : ''}`}
                aria-pressed={category.rows.includes(row)}
                onClick={() => toggleRow(index, row)}
              >
                {row}
              </button>
            ))}
          </div>
        </div>
      ))}

      <Button
        variant="secondary"
        disabled={draft.categories.length >= 10}
        onClick={() =>
          onChange({
            ...draft,
            categories: [...draft.categories, { name: '', price: '0.00', rows: [] }],
          })
        }
      >
        Add category
      </Button>

      {errors.length > 0 ? (
        <ul className="field__error" aria-live="polite">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : (
        <p className="field__hint">
          {rows * (Number(draft.seatsPerRow) || 0)} seats will be generated.
        </p>
      )}
    </fieldset>
  );
}
