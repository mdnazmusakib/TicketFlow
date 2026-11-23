import type { AuthContext } from '../middlewares/auth';
import type { ValidatedRequestData } from '../middlewares/validate';

declare global {
  namespace Express {
    interface Request {
      /** Zod-parsed request parts set by the validate middleware. */
      validated?: ValidatedRequestData;
      /** Authenticated principal set by the authenticate middleware. */
      auth?: AuthContext;
      /** Rate-limit identity resolved by the clientIp middleware (never a raw client header). */
      clientIp?: string;
      /** True when the request carried a valid signature from the trusted edge proxy. */
      viaTrustedProxy?: boolean;
    }
  }
}

export {};
