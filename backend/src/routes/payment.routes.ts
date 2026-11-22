import express, { Router, type RequestHandler } from 'express';
import type { PaymentController } from '../controllers/PaymentController';
import { requireRole } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { idParamsSchema } from '../schemas/event.schemas';
import {
  mockCompleteSchema,
  providerParamsSchema,
  sslReturnParamsSchema,
  transactionRefParamsSchema,
} from '../schemas/payment.schemas';

/** Provider-facing routes: no session, form or JSON bodies, CORS-exempt (see app.ts). */
export function createProviderCallbackRouter(controller: PaymentController): Router {
  const router = Router();
  const form = express.urlencoded({ extended: false, limit: '50kb' });
  router.post(
    '/webhooks/:provider',
    form,
    validate({ params: providerParamsSchema }),
    controller.webhook,
  );
  router.post(
    '/providers/sslcommerz/return/:result',
    form,
    validate({ params: sslReturnParamsSchema }),
    controller.sslReturn,
  );
  return router;
}

/** /api/payments — customer payment endpoints. */
export function createPaymentRouter(
  controller: PaymentController,
  guards: { authenticate: RequestHandler; bookingLimiter: RequestHandler },
): Router {
  const router = Router();
  router.use(guards.authenticate);
  router.get('/providers', controller.providers);
  router.get(
    '/mock/:transactionRef',
    validate({ params: transactionRefParamsSchema }),
    controller.mockView,
  );
  router.post(
    '/mock/complete',
    requireRole('CUSTOMER'),
    guards.bookingLimiter,
    validate({ body: mockCompleteSchema }),
    controller.mockComplete,
  );
  router.get('/:id', validate({ params: idParamsSchema }), controller.status);
  router.post(
    '/:id/cancel',
    guards.bookingLimiter,
    validate({ params: idParamsSchema }),
    controller.cancelAttempt,
  );
  return router;
}
