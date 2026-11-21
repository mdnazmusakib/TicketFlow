/**
 * Seat map rules shared by the API, the seed and the frontend contract:
 * a rectangular grid of `rows x seatsPerRow`, rows labelled A..Z, AA..AZ,
 * every row assigned to exactly one category.
 */
export const MAX_SEAT_ROWS = 52;
export const MAX_SEATS_PER_ROW = 100;
export const MAX_CATEGORIES = 10;

export interface SeatCategoryDefinition {
  name: string;
  priceMinor: number;
  rows: string[];
}

export interface SeatMapDefinition {
  rows: number;
  seatsPerRow: number;
  categories: SeatCategoryDefinition[];
}

export interface GeneratedSeat {
  rowLabel: string;
  seatNumber: number;
  categoryName: string;
}

export function rowLabel(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_SEAT_ROWS) {
    throw new Error('Row index out of range');
  }
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return index < 26 ? letters[index]! : `A${letters[index - 26]!}`;
}

export function rowLabels(rows: number): string[] {
  return Array.from({ length: rows }, (_, index) => rowLabel(index));
}

/** Returns human-readable problems; empty array means the map is valid. */
export function validateSeatMap(map: SeatMapDefinition): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(map.rows) || map.rows < 1 || map.rows > MAX_SEAT_ROWS) {
    problems.push(`rows must be between 1 and ${MAX_SEAT_ROWS}`);
  }
  if (
    !Number.isInteger(map.seatsPerRow) ||
    map.seatsPerRow < 1 ||
    map.seatsPerRow > MAX_SEATS_PER_ROW
  ) {
    problems.push(`seatsPerRow must be between 1 and ${MAX_SEATS_PER_ROW}`);
  }
  if (map.categories.length === 0 || map.categories.length > MAX_CATEGORIES) {
    problems.push(`between 1 and ${MAX_CATEGORIES} categories are required`);
  }
  if (problems.length > 0) return problems;

  const names = new Set<string>();
  for (const category of map.categories) {
    const key = category.name.trim().toLowerCase();
    if (names.has(key)) problems.push(`duplicate category name "${category.name}"`);
    names.add(key);
    if (category.rows.length === 0) problems.push(`category "${category.name}" has no rows`);
  }

  const valid = new Set(rowLabels(map.rows));
  const assigned = new Map<string, string>();
  for (const category of map.categories) {
    for (const row of category.rows) {
      if (!valid.has(row)) problems.push(`row ${row} does not exist in a ${map.rows}-row map`);
      else if (assigned.has(row)) problems.push(`row ${row} is assigned to more than one category`);
      else assigned.set(row, category.name);
    }
  }
  const unassigned = [...valid].filter((row) => !assigned.has(row));
  if (unassigned.length > 0) problems.push(`rows without a category: ${unassigned.join(', ')}`);
  return problems;
}

export function generateSeats(map: SeatMapDefinition): GeneratedSeat[] {
  const categoryByRow = new Map<string, string>();
  for (const category of map.categories)
    for (const row of category.rows) categoryByRow.set(row, category.name);
  const seats: GeneratedSeat[] = [];
  for (const label of rowLabels(map.rows)) {
    const categoryName = categoryByRow.get(label);
    if (!categoryName) throw new Error(`Row ${label} has no category`);
    for (let seatNumber = 1; seatNumber <= map.seatsPerRow; seatNumber += 1) {
      seats.push({ rowLabel: label, seatNumber, categoryName });
    }
  }
  return seats;
}
