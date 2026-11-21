import { randomUUID } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { isRole, type Role } from '../../domain/auth/roles';
import { RedisKeys } from '../../infrastructure/redis/keys';
import type { TtlStore } from '../../infrastructure/redis/TtlStore';
import { UnauthorizedError } from '../../shared/errors/AppError';

export interface TokenClaims {
  userId: string;
  role: Role;
  jti: string;
  expiresAt: Date;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

const ISSUER = 'ticketflow-api';
const AUDIENCE = 'ticketflow-web';

/** HS256 JWTs with a unique jti so logout can revoke a token before it expires. */
export class TokenService {
  constructor(
    private readonly store: TtlStore,
    private readonly options: { secret: string; expiresIn: string },
  ) {}

  issue(user: { id: string; role: Role }): IssuedToken {
    const token = jwt.sign({ role: user.role }, this.options.secret, {
      algorithm: 'HS256',
      subject: user.id,
      jwtid: randomUUID(),
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: this.options.expiresIn as jwt.SignOptions['expiresIn'],
    });
    const { exp } = jwt.decode(token) as JwtPayload;
    return { token, expiresAt: new Date((exp ?? 0) * 1000) };
  }

  /** Verifies signature, algorithm, issuer, audience, expiry and revocation. */
  async verify(token: string): Promise<TokenClaims> {
    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, this.options.secret, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      }) as JwtPayload;
    } catch {
      throw new UnauthorizedError('Session is invalid or has expired');
    }

    const { sub, jti, exp, role } = payload;
    if (!sub || !jti || !exp || !isRole(role)) {
      throw new UnauthorizedError('Session is invalid or has expired');
    }
    if (await this.store.get(RedisKeys.revokedToken(jti))) {
      throw new UnauthorizedError('Session has been signed out');
    }
    return { userId: sub, role, jti, expiresAt: new Date(exp * 1000) };
  }

  /** Denylists the token id until its natural expiry. */
  async revoke(claims: Pick<TokenClaims, 'jti' | 'expiresAt'>): Promise<void> {
    const ttl = Math.ceil((claims.expiresAt.getTime() - Date.now()) / 1000);
    if (ttl > 0) await this.store.set(RedisKeys.revokedToken(claims.jti), '1', ttl);
  }
}
