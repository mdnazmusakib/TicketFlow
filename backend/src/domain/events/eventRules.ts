/** Event-level invariants checked in the service before hitting database constraints. */
export const EVENT_STATUSES = ['DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const PRICING_STRATEGIES = ['BASE', 'EARLY_BIRD'] as const;
export type PricingStrategyName = (typeof PRICING_STRATEGIES)[number];

export type PricingConfig =
  { strategy: 'BASE' } | { strategy: 'EARLY_BIRD'; earlyBirdDeadline: Date; discountPct: number };

export interface EventSchedule {
  startAt: Date;
  endAt: Date | null;
  salesStartAt: Date | null;
  salesEndAt: Date | null;
  pricing: PricingConfig;
}

export function validateSchedule(schedule: EventSchedule, now: Date = new Date()): string[] {
  const problems: string[] = [];
  const { startAt, endAt, salesStartAt, salesEndAt, pricing } = schedule;
  if (startAt.getTime() <= now.getTime()) problems.push('startAt must be in the future');
  if (endAt && endAt.getTime() <= startAt.getTime()) problems.push('endAt must be after startAt');
  if (salesStartAt && salesEndAt && salesStartAt.getTime() >= salesEndAt.getTime()) {
    problems.push('salesStartAt must be before salesEndAt');
  }
  if (salesEndAt && salesEndAt.getTime() > startAt.getTime()) {
    problems.push('salesEndAt must not be after startAt');
  }
  if (pricing.strategy === 'EARLY_BIRD') {
    if (pricing.earlyBirdDeadline.getTime() > startAt.getTime()) {
      problems.push('earlyBirdDeadline must not be after startAt');
    }
    if (
      !Number.isInteger(pricing.discountPct) ||
      pricing.discountPct < 1 ||
      pricing.discountPct > 99
    ) {
      problems.push('discountPct must be between 1 and 99');
    }
  }
  return problems;
}

/** Statuses in which organizers may still edit an event. */
export function isEditableStatus(status: EventStatus): boolean {
  return status === 'DRAFT' || status === 'PUBLISHED';
}
