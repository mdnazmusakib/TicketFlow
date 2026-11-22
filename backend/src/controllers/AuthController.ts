import type { CookieOptions, Request, Response } from 'express';
import { type z } from 'zod';
import type { AppConfig } from '../config/env';
import { getAuth } from '../middlewares/auth';
import type {
  loginSchema,
  registerSchema,
  resendOtpSchema,
  verifyOtpSchema,
} from '../schemas/auth.schemas';
import type { AuthService } from '../services/auth/AuthService';
import type { IssuedToken } from '../services/auth/TokenService';
import { sendSuccess } from '../shared/http/apiResponse';

type CookieConfig = AppConfig['auth']['cookie'];

/** HTTP adapter for authentication. Business rules live in AuthService. */
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookie: CookieConfig,
  ) {}

  register = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as z.output<typeof registerSchema>;
    const result = await this.auth.register(body);
    if (result.session) this.setSessionCookie(res, result.session);
    sendSuccess(res, { user: result.user, verificationRequired: result.verificationRequired }, 201);
  };

  verifyOtp = async (req: Request, res: Response): Promise<void> => {
    const { email, otp } = req.body as z.output<typeof verifyOtpSchema>;
    const { user, session } = await this.auth.verifyEmail(email, otp);
    this.setSessionCookie(res, session);
    sendSuccess(res, { user });
  };

  resendOtp = async (req: Request, res: Response): Promise<void> => {
    const { email } = req.body as z.output<typeof resendOtpSchema>;
    await this.auth.resendOtp(email);
    sendSuccess(
      res,
      { message: 'If the account exists and is unverified, a new code has been sent.' },
      202,
    );
  };

  login = async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body as z.output<typeof loginSchema>;
    const { user, session } = await this.auth.login(email, password);
    this.setSessionCookie(res, session);
    sendSuccess(res, { user });
  };

  logout = async (req: Request, res: Response): Promise<void> => {
    await this.auth.logout(getAuth(req).claims);
    res.clearCookie(this.cookie.name, this.baseCookieOptions());
    sendSuccess(res, { message: 'Signed out' });
  };

  me = (req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { user: getAuth(req).user });
  };

  private baseCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.cookie.secure,
      sameSite: this.cookie.sameSite,
      path: '/',
    };
  }

  private setSessionCookie(res: Response, session: IssuedToken): void {
    res.cookie(this.cookie.name, session.token, {
      ...this.baseCookieOptions(),
      expires: session.expiresAt,
    });
  }
}
