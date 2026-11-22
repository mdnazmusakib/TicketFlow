import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookingDetailPage } from '../src/features/bookings/BookingDetailPage';
import type {
  Booking,
  BookingsApi,
  Payment,
  PaymentResult,
} from '../src/features/bookings/bookingsApi';
import { MockCheckoutPage } from '../src/features/payments/MockCheckoutPage';
import { PaymentResultPage } from '../src/features/payments/PaymentResultPage';
import { ApiError } from '../src/lib/apiClient';
import { customerUser, fakeAuthApi, renderRoute } from './testUtils';

const baseBooking: Booking = {
  id: 'b1',
  status: 'HELD',
  eventId: 'e1',
  event: {
    title: 'Rock Night',
    startAt: '2027-01-10T14:00:00.000Z',
    venueName: 'Arena',
    venueCity: 'Dhaka',
    timezone: 'Asia/Dhaka',
  },
  holdExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  pricingStrategy: 'BASE',
  totalAmountMinor: 200000,
  refundAmountMinor: 0,
  currency: 'BDT',
  seats: [
    { seatId: 's1', row: 'A', number: 1, category: 'General', priceMinor: 200000, state: 'HELD' },
  ],
  history: [{ from: null, to: 'HELD', reason: 'seat hold', at: '2026-11-21T10:00:00.000Z' }],
  confirmedAt: null,
  cancelledAt: null,
  expiredAt: null,
  createdAt: '2026-11-21T10:00:00.000Z',
  serverTime: new Date().toISOString(),
  payments: [],
  refunds: [],
};

const payment = (overrides: Partial<Payment> = {}): Payment => ({
  id: 'p1',
  bookingId: 'b1',
  provider: 'MOCK_PROVIDER_A',
  status: 'PENDING',
  amountMinor: 200000,
  currency: 'BDT',
  transactionRef: 'TF0123456789abcdef',
  redirectUrl: 'http://localhost:5173/payments/mock-checkout?ref=TF0123456789abcdef',
  failureReason: null,
  paidAt: null,
  createdAt: '2026-11-21T10:01:00.000Z',
  ...overrides,
});

const confirmed: Booking = {
  ...baseBooking,
  status: 'CONFIRMED',
  holdExpiresAt: null,
  seats: [{ ...baseBooking.seats[0]!, state: 'BOOKED' }],
  payments: [
    payment({ status: 'SUCCEEDED', redirectUrl: null, paidAt: '2026-11-21T10:02:00.000Z' }),
  ],
};

function fakeApi(overrides: Partial<BookingsApi> = {}): jest.Mocked<BookingsApi> {
  return {
    quote: jest.fn(),
    hold: jest.fn(),
    list: jest.fn(),
    get: jest.fn().mockResolvedValue(baseBooking),
    checkout: jest.fn(),
    cancel: jest.fn(),
    providers: jest.fn().mockResolvedValue({
      providers: ['MOCK_PROVIDER_A', 'MOCK_PROVIDER_B', 'SSLCOMMERZ'],
      mockProviderBTokens: ['tok_success', 'tok_decline', 'tok_timeout'],
    }),
    pay: jest.fn(),
    paymentStatus: jest.fn(),
    cancelPayment: jest.fn(),
    mockCheckout: jest.fn(),
    mockComplete: jest.fn(),
    cancellationPreview: jest.fn(),
    retryRefund: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<BookingsApi>;
}

const asCustomer = { auth: fakeAuthApi(customerUser) };
const detailRoute = { path: '/bookings/:id', at: '/bookings/b1', ...asCustomer };

describe('PaymentPanel on the booking page', () => {
  it('starts a hosted payment and redirects to the provider page', async () => {
    const redirect = jest.fn();
    const api = fakeApi({
      pay: jest.fn().mockResolvedValue({
        payment: payment(),
        booking: { ...baseBooking, status: 'PENDING_PAYMENT' },
      }),
    });
    renderRoute(<BookingDetailPage api={api} redirect={redirect} />, detailRoute);

    expect(await screen.findByRole('radio', { name: /Mock Provider A/ })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: /Pay BDT\s?2,000\.00/ }));
    await waitFor(() => expect(redirect).toHaveBeenCalledWith(payment().redirectUrl));
    expect(api.pay).toHaveBeenCalledWith('b1', 'MOCK_PROVIDER_A', expect.any(String), undefined);
  });

  it('pays with a Mock Provider B test card and shows the confirmed booking', async () => {
    const api = fakeApi({
      pay: jest.fn().mockResolvedValue({
        payment: payment({ provider: 'MOCK_PROVIDER_B', status: 'SUCCEEDED', redirectUrl: null }),
        booking: confirmed,
      }),
    });
    renderRoute(<BookingDetailPage api={api} />, detailRoute);
    await userEvent.click(await screen.findByRole('radio', { name: /Mock Provider B/ }));
    await userEvent.selectOptions(screen.getByLabelText('Test card'), 'tok_success');
    await userEvent.click(screen.getByRole('button', { name: /Pay/ }));
    expect(
      await screen.findByText('Payment received. Your tickets are confirmed.'),
    ).toBeInTheDocument();
    expect(api.pay).toHaveBeenCalledWith(
      'b1',
      'MOCK_PROVIDER_B',
      expect.any(String),
      'tok_success',
    );
    expect(screen.queryByRole('heading', { name: 'Payment' })).not.toBeInTheDocument();
  });

  it('shows declines and uses a fresh idempotency key for the retry', async () => {
    const api = fakeApi({
      pay: jest
        .fn()
        .mockResolvedValueOnce({
          payment: payment({
            provider: 'MOCK_PROVIDER_B',
            status: 'FAILED',
            redirectUrl: null,
            failureReason: 'Payment declined',
          }),
          booking: { ...baseBooking, status: 'PENDING_PAYMENT' },
        })
        .mockResolvedValueOnce({
          payment: payment({ status: 'SUCCEEDED', redirectUrl: null }),
          booking: confirmed,
        }),
    });
    renderRoute(<BookingDetailPage api={api} />, detailRoute);
    await userEvent.click(await screen.findByRole('radio', { name: /Mock Provider B/ }));
    await userEvent.click(screen.getByRole('button', { name: /Pay/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Payment failed: Payment declined');
    await userEvent.click(screen.getByRole('button', { name: /Pay/ }));
    await screen.findByText('Payment received. Your tickets are confirmed.');
    const [first, second] = api.pay.mock.calls;
    expect(first![2]).not.toBe(second![2]);
  });

  it('polls a payment whose outcome is pending until it resolves', async () => {
    const pending: Booking = {
      ...baseBooking,
      status: 'PENDING_PAYMENT',
      payments: [payment({ provider: 'MOCK_PROVIDER_B', redirectUrl: null })],
    };
    const api = fakeApi({
      get: jest.fn().mockResolvedValue(pending),
      paymentStatus: jest.fn().mockResolvedValue({
        payment: payment({ status: 'SUCCEEDED' }),
        booking: confirmed,
      } satisfies PaymentResult),
    });
    renderRoute(<BookingDetailPage api={api} />, detailRoute);
    expect(
      await screen.findByText('Waiting for the provider to confirm your payment…'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Payment received. Your tickets are confirmed.',
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  });

  it('resumes or abandons an open hosted attempt', async () => {
    const redirect = jest.fn();
    const open: Booking = { ...baseBooking, status: 'PENDING_PAYMENT', payments: [payment()] };
    const api = fakeApi({
      get: jest.fn().mockResolvedValue(open),
      cancelPayment: jest.fn().mockResolvedValue({
        payment: payment({ status: 'CANCELLED', redirectUrl: null }),
        booking: { ...open, payments: [payment({ status: 'CANCELLED', redirectUrl: null })] },
      }),
    });
    renderRoute(<BookingDetailPage api={api} redirect={redirect} />, detailRoute);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue payment' }));
    expect(redirect).toHaveBeenCalledWith(payment().redirectUrl);
    await userEvent.click(screen.getByRole('button', { name: 'Use another method' }));
    expect(
      await screen.findByText('Payment attempt cancelled. Choose another method.'),
    ).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: /SSLCommerz/ })).toBeInTheDocument();
  });

  it('shows API errors such as an expired hold', async () => {
    const api = fakeApi({
      pay: jest
        .fn()
        .mockRejectedValue(
          new ApiError(409, 'HOLD_EXPIRED', 'Your seat hold expired. Please select seats again.'),
        ),
    });
    renderRoute(<BookingDetailPage api={api} />, detailRoute);
    await userEvent.click(await screen.findByRole('button', { name: /Pay/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('seat hold expired');
  });
});

describe('Cancellation and refund display', () => {
  it('shows the full-refund decision before cancelling a confirmed booking', async () => {
    const api = fakeApi({
      get: jest.fn().mockResolvedValue(confirmed),
      cancellationPreview: jest.fn().mockResolvedValue({
        refundable: true,
        refundAmountMinor: 200000,
        hoursUntilEvent: 200,
        bookingStatus: 'CONFIRMED',
        paidAmountMinor: 200000,
        currency: 'BDT',
        cancellable: true,
      }),
      cancel: jest.fn().mockResolvedValue({
        ...confirmed,
        status: 'CANCELLED',
        refundAmountMinor: 200000,
        refundDecision: { refundable: true, refundAmountMinor: 200000, hoursUntilEvent: 200 },
        refunds: [
          {
            id: 'r1',
            status: 'SUCCEEDED',
            amountMinor: 200000,
            currency: 'BDT',
            attempt: 1,
            reason: 'x',
            failureReason: null,
            processedAt: 'x',
            nextRetryAt: null,
            createdAt: 'x',
          },
        ],
      }),
    });
    renderRoute(<BookingDetailPage api={api} />, detailRoute);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel booking' }));
    expect(await screen.findByRole('dialog', { name: 'Confirm cancellation' })).toHaveTextContent(
      /full refund of BDT\s?2,000\.00/,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    expect(
      await screen.findByText(/A full refund of BDT\s?2,000\.00 has been requested/),
    ).toBeInTheDocument();
    expect(screen.getByText('Refunded')).toBeInTheDocument();
  });

  it('warns that cancelling within 24 hours gives no refund, and keeps the booking on request', async () => {
    const api = fakeApi({
      get: jest.fn().mockResolvedValue(confirmed),
      cancellationPreview: jest.fn().mockResolvedValue({
        refundable: false,
        refundAmountMinor: 0,
        hoursUntilEvent: 5,
        bookingStatus: 'CONFIRMED',
        paidAmountMinor: 200000,
        currency: 'BDT',
        cancellable: true,
      }),
    });
    renderRoute(<BookingDetailPage api={api} />, detailRoute);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel booking' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Cancelling now gives no refund');
    await userEvent.click(screen.getByRole('button', { name: 'Keep booking' }));
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it('shows a failed refund and retries it', async () => {
    const failedRefund = {
      id: 'r1',
      status: 'FAILED' as const,
      amountMinor: 200000,
      currency: 'BDT',
      attempt: 1,
      reason: 'x',
      failureReason: 'Issuer temporarily unavailable',
      processedAt: 'x',
      nextRetryAt: '2026-11-21T10:10:00.000Z',
      createdAt: 'x',
    };
    const cancelled: Booking = { ...confirmed, status: 'CANCELLED', refunds: [failedRefund] };
    const api = fakeApi({
      get: jest.fn().mockResolvedValue(cancelled),
      retryRefund: jest.fn().mockResolvedValue({
        ...cancelled,
        refundAmountMinor: 200000,
        refunds: [
          failedRefund,
          { ...failedRefund, id: 'r2', attempt: 2, status: 'SUCCEEDED', failureReason: null },
        ],
      }),
    });
    renderRoute(<BookingDetailPage api={api} />, detailRoute);
    expect(await screen.findByText('Refund failed')).toBeInTheDocument();
    expect(screen.getByText(/Issuer temporarily unavailable/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry refund now' }));
    expect(await screen.findByText('Refunded')).toBeInTheDocument();
    expect(screen.getByText(/Attempt 2: Refunded/)).toBeInTheDocument();
  });

  it('says when no refund applies', async () => {
    renderRoute(
      <BookingDetailPage
        api={fakeApi({ get: jest.fn().mockResolvedValue({ ...confirmed, status: 'CANCELLED' }) })}
      />,
      detailRoute,
    );
    expect(await screen.findByText('No refund applies to this cancellation.')).toBeInTheDocument();
  });
});

describe('Mock checkout and payment result pages', () => {
  it('completes the mock hosted checkout and lands on the result page', async () => {
    const api = fakeApi({
      mockCheckout: jest.fn().mockResolvedValue({ payment: payment(), booking: baseBooking }),
      mockComplete: jest
        .fn()
        .mockResolvedValue({ payment: payment({ status: 'SUCCEEDED' }), booking: confirmed }),
    });
    renderRoute(<MockCheckoutPage api={api} />, {
      path: '/payments/mock-checkout',
      at: '/payments/mock-checkout?ref=TF0123456789abcdef',
      ...asCustomer,
      extra: [{ path: '/payments/:id/result', element: <p>Result page</p> }],
    });
    expect(await screen.findByRole('heading', { name: /Pay BDT\s?2,000\.00/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Pay now' }));
    expect(await screen.findByText('Result page')).toBeInTheDocument();
    expect(api.mockComplete).toHaveBeenCalledWith('TF0123456789abcdef', 'success');
  });

  it('shows success, failure and pending results from server-side status', async () => {
    const success = fakeApi({
      paymentStatus: jest
        .fn()
        .mockResolvedValue({ payment: payment({ status: 'SUCCEEDED' }), booking: confirmed }),
    });
    const { unmount } = renderRoute(<PaymentResultPage api={success} />, {
      path: '/payments/:id/result',
      at: '/payments/p1/result',
      ...asCustomer,
    });
    expect(await screen.findByRole('heading', { name: 'Payment successful' })).toBeInTheDocument();
    unmount();

    const failed = fakeApi({
      paymentStatus: jest.fn().mockResolvedValue({
        payment: payment({ status: 'FAILED', failureReason: 'Payment declined' }),
        booking: baseBooking,
      }),
    });
    const second = renderRoute(<PaymentResultPage api={failed} />, {
      path: '/payments/:id/result',
      at: '/payments/p1/result',
      ...asCustomer,
    });
    expect(await screen.findByRole('heading', { name: 'Payment failed' })).toBeInTheDocument();
    expect(screen.getByText(/Payment declined/)).toBeInTheDocument();
    second.unmount();

    const pendingThenOk = fakeApi({
      paymentStatus: jest
        .fn()
        .mockResolvedValueOnce({ payment: payment(), booking: baseBooking })
        .mockResolvedValue({ payment: payment({ status: 'SUCCEEDED' }), booking: confirmed }),
    });
    const third = renderRoute(<PaymentResultPage api={pendingThenOk} pollMs={20} />, {
      path: '/payments/:id/result',
      at: '/payments/p1/result',
      ...asCustomer,
    });
    expect(await screen.findByRole('heading', { name: 'Payment pending' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Payment successful' })).toBeInTheDocument();
    third.unmount();

    const late = fakeApi({
      paymentStatus: jest.fn().mockResolvedValue({
        payment: payment({ status: 'SUCCEEDED' }),
        booking: { ...baseBooking, status: 'EXPIRED' },
      }),
    });
    renderRoute(<PaymentResultPage api={late} />, {
      path: '/payments/:id/result',
      at: '/payments/p1/result',
      ...asCustomer,
    });
    expect(
      await screen.findByRole('heading', { name: 'Payment received, booking not confirmed' }),
    ).toBeInTheDocument();
  });

  it('handles unknown or missing payments', async () => {
    const { unmount } = renderRoute(<PaymentResultPage api={fakeApi()} />, {
      path: '/payments/:id/result',
      at: '/payments/unknown/result',
      ...asCustomer,
    });
    expect(
      screen.getByRole('heading', { name: 'We could not identify this payment' }),
    ).toBeInTheDocument();
    unmount();
    const missing = fakeApi({
      paymentStatus: jest
        .fn()
        .mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Payment not found')),
    });
    renderRoute(<PaymentResultPage api={missing} />, {
      path: '/payments/:id/result',
      at: '/payments/zzz/result',
      ...asCustomer,
    });
    expect(await screen.findByText('Payment not found.')).toBeInTheDocument();
  });
});
