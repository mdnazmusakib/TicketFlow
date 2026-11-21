import type { RequestHandler } from 'express';
import type { Actor, Role } from '../domain/auth/roles';
import type { AuthService, PublicUser } from '../services/auth/AuthService';
import type { TokenClaims } from '../services/auth/TokenService';
import { ForbiddenError, UnauthorizedError } from '../shared/errors/AppError';

export interface AuthContext {
  actor: Actor;
  user: PublicUser;
  claims: TokenClaims;
}

/**
 * Reads the session JWT from the httpOnly cookie only (never from query
 * strings or localStorage) and attaches the actor. Missing/invalid -> 401.
 */
export function createAuthenticate(authService: AuthService, cookieName: string): RequestHandler {
  return async (req, _res, next) => {
    const token: unknown = req.cookies?.[cookieName];
    if (typeof token !== 'string' || token.length === 0) {
      next(new UnauthorizedError());
      return;
    }
    try {
      req.auth = await authService.authenticate(token);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Role gate. Must run after authenticate. Authorization never trusts client-side checks. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(new UnauthorizedError());
      return;
    }
    if (!roles.includes(req.auth.actor.role)) {
      next(new ForbiddenError());
      return;
    }
    next();
  };
}

/** Typed accessor for controllers on authenticated routes. */
export function getAuth(req: { auth?: AuthContext }): AuthContext {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
}
