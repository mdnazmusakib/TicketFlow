export const ROLES = ['CUSTOMER', 'ORGANIZER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/** Roles a visitor may pick at signup. ADMIN accounts are provisioned, never self-registered. */
export const SELF_REGISTRATION_ROLES = ['CUSTOMER', 'ORGANIZER'] as const;
export type SelfRegistrationRole = (typeof SELF_REGISTRATION_ROLES)[number];

/** The authenticated principal performing an action. */
export interface Actor {
  id: string;
  role: Role;
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Ownership rule shared by every organizer-owned resource: the owner may
 * manage it; ADMIN may manage everything. Everyone else is denied.
 */
export function canManageResource(actor: Actor, ownerId: string): boolean {
  return actor.role === 'ADMIN' || actor.id === ownerId;
}
