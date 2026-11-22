import type { Request, Response } from 'express';
import type { z } from 'zod';
import { getAuth } from '../middlewares/auth';
import { getValidated } from '../middlewares/validate';
import {
  idempotencyKeySchema,
  type bookingListSchema,
  type cancelBookingSchema,
  type seatSelectionSchema,
} from '../schemas/booking.schemas';
import type { idParamsSchema } from '../schemas/event.schemas';
import type { BookingService } from '../services/booking/BookingService';
import type { CancellationService } from '../services/payments/CancellationService';
import { ValidationError } from '../shared/errors/AppError';
import { sendSuccess } from '../shared/http/apiResponse';

type IdParams = z.output<typeof idParamsSchema>;

/** HTTP adapter for bookings; all rules live in BookingService. */
export class BookingController {
  constructor(
    private readonly bookings: BookingService,
    private readonly cancellations: CancellationService,
  ) {}

  quote = async (req: Request, res: Response) => {
    const body = req.body as z.output<typeof seatSelectionSchema>;
    sendSuccess(res, await this.bookings.quote(body.eventId, body.seatIds));
  };

  hold = async (req: Request, res: Response) => {
    const body = req.body as z.output<typeof seatSelectionSchema>;
    const header = req.get('idempotency-key');
    let idempotencyKey: string | undefined;
    if (header !== undefined) {
      const parsed = idempotencyKeySchema.safeParse(header);
      if (!parsed.success) {
        throw new ValidationError([
          { path: 'headers.idempotency-key', message: parsed.error.issues[0]!.message },
        ]);
      }
      idempotencyKey = parsed.data;
    }
    const { booking, replayed } = await this.bookings.hold(getAuth(req).actor, {
      ...body,
      idempotencyKey,
    });
    sendSuccess(res, booking, replayed ? 200 : 201);
  };

  list = async (req: Request, res: Response) => {
    const { query } = getValidated<{ query: z.output<typeof bookingListSchema> }>(req);
    const { items, meta } = await this.bookings.list(getAuth(req).actor, query);
    sendSuccess(res, items, 200, meta);
  };

  get = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, await this.bookings.get(getAuth(req).actor, params.id));
  };

  checkout = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    sendSuccess(res, await this.bookings.checkout(getAuth(req).actor, params.id));
  };

  cancel = async (req: Request, res: Response) => {
    const { params, body } = getValidated<{
      params: IdParams;
      body: z.output<typeof cancelBookingSchema>;
    }>(req);
    const { booking, refund } = await this.cancellations.cancel(
      getAuth(req).actor,
      params.id,
      body.reason,
    );
    sendSuccess(res, { ...booking, refundDecision: refund });
  };

  cancellationPreview = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, await this.cancellations.preview(getAuth(req).actor, params.id));
  };

  retryRefund = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    sendSuccess(res, await this.cancellations.retryRefund(getAuth(req).actor, params.id));
  };
}
