import type { AuthContext } from '../middlewares/auth';
import type { ValidatedRequestData } from '../middlewares/validate';

declare global {
  namespace Express {
    interface Request {
      /** Zod-parsed request parts set by the validate middleware. */
      validated?: ValidatedRequestData;
      /** Authenticated principal set by the authenticate middleware. */
      auth?: AuthContext;
    }
  }
}

export {};
