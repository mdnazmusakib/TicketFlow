import type { Request, Response } from 'express';
import type { z } from 'zod';
import { getAuth } from '../middlewares/auth';
import { getValidated } from '../middlewares/validate';
import type { idParamsSchema } from '../schemas/event.schemas';
import {
  paymentIdempotencyKeySchema,
  type initiatePaymentSchema,
  type mockCompleteSchema,
  type providerParamsSchema,
  type sslReturnParamsSchema,
  type transactionRefParamsSchema,
} from '../schemas/payment.schemas';
import type { MockCheckoutService } from '../services/payments/MockCheckoutService';
import type { PaymentService } from '../services/payments/PaymentService';
import type { WebhookService } from '../services/payments/WebhookService';
import { ValidationError } from '../shared/errors/AppError';
import { sendSuccess } from '../shared/http/apiResponse';

type IdParams = z.output<typeof idParamsSchema>;

/** HTTP adapter for payments, provider callbacks and the mock provider checkout. */
export class PaymentController {
  constructor(
    private readonly payments: PaymentService,
    private readonly webhooks: WebhookService,
    private readonly mockCheckout: MockCheckoutService,
    private readonly options: { frontendUrl: string },
  ) {}

  providers = (_req: Request, res: Response) => {
    sendSuccess(res, {
      providers: this.payments.enabledProviders(),
      mockProviderBTokens: this.payments.mockProviderBTokens(),
    });
  };

  initiate = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    const body = req.body as z.output<typeof initiatePaymentSchema>;
    const key = paymentIdempotencyKeySchema.safeParse(req.get('idempotency-key'));
    if (!key.success) {
      throw new ValidationError([
        { path: 'headers.idempotency-key', message: key.error.issues[0]!.message },
      ]);
    }
    const result = await this.payments.initiate(getAuth(req).actor, params.id, body, key.data);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    sendSuccess(res, result.body, result.replayed ? 200 : result.status);
  };

  status = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, await this.payments.status(getAuth(req).actor, params.id));
  };

  cancelAttempt = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    sendSuccess(res, await this.payments.cancelAttempt(getAuth(req).actor, params.id));
  };

  /** Mock Provider A checkout page data (owner only). */
  mockView = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: z.output<typeof transactionRefParamsSchema> }>(req);
    sendSuccess(res, await this.mockCheckout.view(getAuth(req).actor, params.transactionRef));
  };

  /** Simulates the customer completing Mock Provider A's hosted page (the provider then sends a signed webhook). */
  mockComplete = async (req: Request, res: Response) => {
    const body = req.body as z.output<typeof mockCompleteSchema>;
    sendSuccess(
      res,
      await this.mockCheckout.complete(getAuth(req).actor, body.transactionRef, body.outcome),
    );
  };

  /** Provider webhook / IPN endpoint (no session; trust comes from signatures + server-side verification). */
  webhook = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: z.output<typeof providerParamsSchema> }>(req);
    const outcome = await this.webhooks.handle(params.provider, {
      headers: req.headers,
      rawBody: (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(''),
      body: req.body as unknown,
    });
    sendSuccess(res, { received: true, status: outcome.status });
  };

  /**
   * Browser return from SSLCommerz (success/fail/cancel). The posted fields only
   * tell us which transaction to verify; the result shown comes from the
   * Order Validation API, never from the posted status.
   */
  sslReturn = async (req: Request, res: Response) => {
    getValidated<{ params: z.output<typeof sslReturnParamsSchema> }>(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ref = typeof body.tran_id === 'string' ? body.tran_id : '';
    const valId = typeof body.val_id === 'string' ? body.val_id : null;
    const payment = ref ? await this.payments.findByTransactionRef(ref) : null;
    if (!payment || payment.provider !== 'SSLCOMMERZ') {
      res.redirect(303, `${this.options.frontendUrl}/payments/unknown/result`);
      return;
    }
    await this.payments.verifyAndApply(payment.id, valId);
    res.redirect(303, `${this.options.frontendUrl}/payments/${payment.id}/result`);
  };
}
