import { Router, type RequestHandler } from 'express';
import type { BookingController } from '../controllers/BookingController';
import { requireRole } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import {
  bookingListSchema,
  cancelBookingSchema,
  seatSelectionSchema,
} from '../schemas/booking.schemas';
import { idParamsSchema } from '../schemas/event.schemas';

/** /api/bookings — signed-in users; creating holds is limited to customers (checked in the service too). */
export function createBookingRouter(
  controller: BookingController,
  guards: { authenticate: RequestHandler; bookingLimiter: RequestHandler },
): Router {
  const router = Router();
  router.use(guards.authenticate);

  router.post('/quote', validate({ body: seatSelectionSchema }), controller.quote);
  router.post(
    '/',
    requireRole('CUSTOMER'),
    guards.bookingLimiter,
    validate({ body: seatSelectionSchema }),
    controller.hold,
  );
  router.get('/', validate({ query: bookingListSchema }), controller.list);
  router.get('/:id', validate({ params: idParamsSchema }), controller.get);
  router.post(
    '/:id/checkout',
    guards.bookingLimiter,
    validate({ params: idParamsSchema }),
    controller.checkout,
  );
  router.post(
    '/:id/cancel',
    guards.bookingLimiter,
    validate({ params: idParamsSchema, body: cancelBookingSchema }),
    controller.cancel,
  );
  return router;
}
