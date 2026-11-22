import { Router, type RequestHandler } from 'express';
import type { AuthController } from '../controllers/AuthController';
import { validate } from '../middlewares/validate';
import {
  loginSchema,
  registerSchema,
  resendOtpSchema,
  verifyOtpSchema,
} from '../schemas/auth.schemas';

export function createAuthRouter(
  controller: AuthController,
  guards: { authenticate: RequestHandler; authLimiter: RequestHandler },
): Router {
  const router = Router();
  const { authenticate, authLimiter } = guards;

  router.post('/register', authLimiter, validate({ body: registerSchema }), controller.register);
  router.post(
    '/verify-otp',
    authLimiter,
    validate({ body: verifyOtpSchema }),
    controller.verifyOtp,
  );
  router.post(
    '/resend-otp',
    authLimiter,
    validate({ body: resendOtpSchema }),
    controller.resendOtp,
  );
  router.post('/login', authLimiter, validate({ body: loginSchema }), controller.login);
  router.post('/logout', authenticate, controller.logout);
  router.get('/me', authenticate, controller.me);
  return router;
}
