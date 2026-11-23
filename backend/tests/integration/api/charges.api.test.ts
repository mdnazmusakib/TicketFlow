import request from 'supertest';
import { createApiHarness, makeAdmin, signUp, type ApiHarness } from '../../helpers/apiHarness';
import { newCustomer, setupPublishedEvent } from '../../helpers/bookingFixtures';
import { FakeSslCommerz } from '../../helpers/fakeSslCommerz';
import { idemKey, pay } from '../../helpers/paymentFixtures';

const HOUR = 3_600_000;

/** Event whose seats all cost `priceMinor` (single "General" row of 5 seats). */
async function eventAt(h: ApiHarness, priceMinor: number, startInDays = 30) {
  return setupPublishedEvent(h, {
    rows: 1,
    seatsPerRow: 5,
    generalPriceMinor: priceMinor,
    startInDays,
  });
}

async function adminAgent(h: ApiHarness) {
  const admin = await signUp(h, 'CUSTOMER');
  await makeAdmin(h, admin.userId);
  return admin.agent;
}

describe('Per-seat platform fee and VAT', () => {
  let h: ApiHarness;
  const ssl = new FakeSslCommerz();

  beforeAll(async () => {
    h = await createApiHarness({ otpBypass: true, paymentGateways: [ssl.adapter()] });
  });

  afterAll(async () => {
    await h.close();
  });

  it('quotes one seat at BDT 500 as 500 + 10 platform charge + 10 VAT = 520', async () => {
    const { eventId, seatIds } = await eventAt(h, 50000);
    const { agent } = await newCustomer(h);
    const quote = await agent
      .post('/api/bookings/quote')
      .send({ eventId, seatIds: [seatIds[0]] })
      .expect(200);
    expect(quote.body.data).toMatchObject({
      ticketTotalMinor: 50000,
      platformFeePerSeatMinor: 1000,
      platformFeeMinor: 1000,
      vatRateBps: 200,
      vatMinor: 1000,
      totalMinor: 52000,
    });
  });

  it('three seats at BDT 500: the booking snapshots 1,500 + 30 + 30 and the payment charges 1,560', async () => {
    const { eventId, seatIds } = await eventAt(h, 50000);
    const { agent } = await newCustomer(h);
    const held = await agent
      .post('/api/bookings')
      .send({ eventId, seatIds: seatIds.slice(0, 3) })
      .expect(201);
    expect(held.body.data).toMatchObject({
      totalAmountMinor: 156000,
      charges: {
        seatCount: 3,
        ticketSubtotalMinor: 150000,
        platformFeePerSeatMinor: 1000,
        platformFeeMinor: 3000,
        vatRateBps: 200,
        vatMinor: 3000,
        grandTotalMinor: 156000,
      },
    });
    const paid = await pay(agent, held.body.data.id, {
      provider: 'MOCK_PROVIDER_B',
      paymentMethodToken: 'tok_success',
    }).expect(201);
    expect(paid.body.data.payment.amountMinor).toBe(156000);
    expect(paid.body.data.booking.status).toBe('CONFIRMED');
  });

  it('rejects client-supplied amounts and empty seat selections', async () => {
    const { eventId, seatIds } = await eventAt(h, 50000);
    const { agent } = await newCustomer(h);
    for (const extra of [
      { totalMinor: 1 },
      { platformFeeMinor: 0 },
      { vatMinor: 0 },
      { charges: {} },
    ]) {
      await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: [seatIds[0]], ...extra })
        .expect(400);
      await agent
        .post('/api/bookings/quote')
        .send({ eventId, seatIds: [seatIds[0]], ...extra })
        .expect(400);
    }
    await agent.post('/api/bookings').send({ eventId, seatIds: [] }).expect(400);
    const held = await agent
      .post('/api/bookings')
      .send({ eventId, seatIds: [seatIds[0]] })
      .expect(201);
    await pay(agent, held.body.data.id, {
      provider: 'MOCK_PROVIDER_B',
      paymentMethodToken: 'tok_success',
      amountMinor: 1,
    }).expect(400);
  });

  it('a provider-reported amount without the fee and VAT does not confirm the booking', async () => {
    const { eventId, seatIds } = await eventAt(h, 50000);
    const { agent } = await newCustomer(h);
    const held = await agent
      .post('/api/bookings')
      .send({ eventId, seatIds: [seatIds[0]] })
      .expect(201);
    const started = await pay(agent, held.body.data.id, { provider: 'SSLCOMMERZ' }).expect(201);
    const ref = started.body.data.payment.transactionRef as string;
    expect(ssl.sessions.get(ref)).toMatchObject({ amount: '520.00' });
    ssl.pay(ref, { reportedAmount: '500.00' }); // ticket price only: fee and VAT missing
    await request(h.app)
      .post('/api/payments/webhooks/SSLCOMMERZ')
      .type('form')
      .send(ssl.ipn(ref))
      .expect(200);
    const view = await agent.get(`/api/bookings/${held.body.data.id}`).expect(200);
    expect(view.body.data.status).not.toBe('CONFIRMED');
  });

  it('duplicate IPN callbacks confirm once and are counted once in the finance report', async () => {
    const admin = await adminAgent(h);
    const before = (await admin.get('/api/admin/finance').expect(200)).body.data;
    const { eventId, seatIds } = await eventAt(h, 50000);
    const { agent } = await newCustomer(h);
    const held = await agent
      .post('/api/bookings')
      .send({ eventId, seatIds: seatIds.slice(0, 2) })
      .expect(201);
    const started = await pay(agent, held.body.data.id, { provider: 'SSLCOMMERZ' }).expect(201);
    const ref = started.body.data.payment.transactionRef as string;
    ssl.pay(ref);
    const ipn = ssl.ipn(ref);
    for (let i = 0; i < 3; i += 1) {
      await request(h.app)
        .post('/api/payments/webhooks/SSLCOMMERZ')
        .type('form')
        .send(ipn)
        .expect(200);
    }
    const view = await agent.get(`/api/bookings/${held.body.data.id}`).expect(200);
    expect(view.body.data.status).toBe('CONFIRMED');
    expect(
      view.body.data.payments.filter((p: { status: string }) => p.status === 'SUCCEEDED'),
    ).toHaveLength(1);
    const after = (await admin.get('/api/admin/finance').expect(200)).body.data;
    expect(after.payments - before.payments).toBe(1);
    expect(after.customerPaymentsMinor - before.customerPaymentsMinor).toBe(104000);
    expect(after.platformRevenue.grossMinor - before.platformRevenue.grossMinor).toBe(2000);
    expect(after.vatLiability.collectedMinor - before.vatLiability.collectedMinor).toBe(2000);
  });

  it('keeps historical bookings unchanged when ticket prices change later', async () => {
    const { organizer, eventId, seatIds } = await eventAt(h, 50000);
    const { agent } = await newCustomer(h);
    const held = await agent
      .post('/api/bookings')
      .send({ eventId, seatIds: [seatIds[0]] })
      .expect(201);
    const details = await organizer.get(`/api/organizer/events/${eventId}`).expect(200);
    const categoryId = details.body.data.categories[0].id as string;
    await organizer
      .patch(`/api/organizer/events/${eventId}/categories/${categoryId}`)
      .send({ priceMinor: 90000 });
    const view = await agent.get(`/api/bookings/${held.body.data.id}`).expect(200);
    expect(view.body.data.charges).toEqual(held.body.data.charges);
    expect(view.body.data.totalAmountMinor).toBe(52000);
    // The database refuses to rewrite the snapshot.
    await expect(
      h.testDb.db.query(
        'UPDATE bookings SET vat_minor = 0, total_amount_minor = 51000 WHERE id = $1',
        [held.body.data.id],
      ),
    ).rejects.toThrow(/immutable|chk_bookings/);
    await expect(
      h.testDb.db.query('UPDATE bookings SET platform_fee_minor = 0 WHERE id = $1', [
        held.body.data.id,
      ]),
    ).rejects.toThrow();
  });
});

describe('Refunds, finance report and organizer earnings', () => {
  let h: ApiHarness;
  const fixedNow = new Date(Math.floor(Date.now() / 1000) * 1000);

  beforeAll(async () => {
    h = await createApiHarness({ otpBypass: true, now: () => fixedNow });
  });

  afterAll(async () => {
    await h.close();
  });

  async function paidBooking(seats: number, priceMinor = 50000) {
    const setup = await eventAt(h, priceMinor, 10);
    const { agent } = await newCustomer(h);
    const held = await agent
      .post('/api/bookings')
      .send({ eventId: setup.eventId, seatIds: setup.seatIds.slice(0, seats) })
      .expect(201);
    await pay(
      agent,
      held.body.data.id,
      { provider: 'MOCK_PROVIDER_B', paymentMethodToken: 'tok_success' },
      idemKey(),
    ).expect(201);
    return { ...setup, agent, bookingId: held.body.data.id as string };
  }

  it('an eligible cancellation refunds the ticket price; platform fee and VAT are kept and recorded apart', async () => {
    const admin = await adminAgent(h);
    const before = (await admin.get('/api/admin/finance').expect(200)).body.data;
    const { agent, bookingId, organizer } = await paidBooking(3);
    const preview = await agent.get(`/api/bookings/${bookingId}/cancellation`).expect(200);
    expect(preview.body.data).toMatchObject({
      refundable: true,
      paidAmountMinor: 156000,
      refundAmountMinor: 150000,
      refundComponents: {
        ticketMinor: 150000,
        platformFeeMinor: 0,
        vatMinor: 0,
        totalMinor: 150000,
      },
      nonRefundable: { platformFeeMinor: 3000, vatMinor: 3000 },
    });
    const cancelled = await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
    expect(cancelled.body.data.refunds).toEqual([
      expect.objectContaining({
        status: 'SUCCEEDED',
        amountMinor: 150000,
        ticketMinor: 150000,
        platformFeeMinor: 0,
        vatMinor: 0,
      }),
    ]);

    const after = (await admin.get('/api/admin/finance').expect(200)).body.data;
    const delta = (path: (d: typeof after) => number) => path(after) - path(before);
    expect(delta((d) => d.ticketSales.grossMinor)).toBe(150000);
    expect(delta((d) => d.ticketSales.refundedMinor)).toBe(150000);
    expect(delta((d) => d.ticketSales.netMinor)).toBe(0);
    expect(delta((d) => d.platformRevenue.netMinor)).toBe(3000); // fee kept: platform revenue
    expect(delta((d) => d.vatLiability.netMinor)).toBe(3000); // VAT kept: liability, not revenue
    expect(delta((d) => d.refundedTotalMinor)).toBe(150000);

    // Organizer: no ticket earnings left for this event, and fee/VAT never count as earnings.
    const overview = await organizer.get('/api/dashboard/organizer').expect(200);
    expect(overview.body.data.totals).toMatchObject({
      grossRevenueMinor: 150000,
      refundedMinor: 150000,
      netRevenueMinor: 0,
      platformFeesMinor: 3000,
      vatMinor: 3000,
    });
  });

  it('a late cancellation refunds nothing and keeps all components as sold', async () => {
    const { agent, bookingId, organizer } = await paidBooking(2, 120000);
    await h.testDb.db.query(
      `UPDATE events SET start_at = $2 WHERE id = (SELECT event_id FROM bookings WHERE id = $1)`,
      [bookingId, new Date(fixedNow.getTime() + 5 * HOUR)],
    );
    const cancelled = await agent.post(`/api/bookings/${bookingId}/cancel`).expect(200);
    expect(cancelled.body.data).toMatchObject({ refundAmountMinor: 0, refunds: [] });
    const overview = await organizer.get('/api/dashboard/organizer').expect(200);
    expect(overview.body.data.totals).toMatchObject({
      grossRevenueMinor: 240000,
      netRevenueMinor: 240000, // organizer keeps the ticket sales
      platformFeesMinor: 2000,
      vatMinor: 4800,
    });
  });

  it('the finance report filters by date and is admin only', async () => {
    const admin = await adminAgent(h);
    await paidBooking(1);
    const today = new Date().toISOString().slice(0, 10);
    const inRange = (await admin.get(`/api/admin/finance?from=${today}&to=${today}`).expect(200))
      .body.data;
    expect(inRange.payments).toBeGreaterThan(0);
    expect(inRange.period.from).toBe(`${today}T00:00:00.000Z`);
    const past = (await admin.get('/api/admin/finance?from=2020-01-01&to=2020-01-31').expect(200))
      .body.data;
    expect(past).toMatchObject({
      payments: 0,
      customerPaymentsMinor: 0,
      platformRevenue: { grossMinor: 0, netMinor: 0 },
      vatLiability: { collectedMinor: 0 },
    });
    // Revenue never includes VAT: customer payments = tickets + fee + VAT.
    expect(inRange.customerPaymentsMinor).toBe(
      inRange.ticketSales.grossMinor +
        inRange.platformRevenue.grossMinor +
        inRange.vatLiability.collectedMinor,
    );
    await admin.get('/api/admin/finance?from=2026-02-30').expect(400);
    await admin.get('/api/admin/finance?from=2026-03-02&to=2026-03-01').expect(400);
    const { agent: customer } = await newCustomer(h);
    await customer.get('/api/admin/finance').expect(403);
    const { agent: organizer } = await signUp(h, 'ORGANIZER');
    await organizer.get('/api/admin/finance').expect(403);
    await request(h.app).get('/api/admin/finance').expect(401);
  });
});

describe('Refund policy configuration (REFUND_PLATFORM_FEE / REFUND_VAT)', () => {
  it('can return the VAT and platform fee as separate refund components', async () => {
    const h = await createApiHarness({
      otpBypass: true,
      env: { REFUND_PLATFORM_FEE: 'true', REFUND_VAT: 'true' },
    });
    try {
      const { eventId, seatIds } = await eventAt(h, 50000, 10);
      const { agent } = await newCustomer(h);
      const held = await agent
        .post('/api/bookings')
        .send({ eventId, seatIds: seatIds.slice(0, 2) })
        .expect(201);
      await pay(agent, held.body.data.id, {
        provider: 'MOCK_PROVIDER_B',
        paymentMethodToken: 'tok_success',
      }).expect(201);
      const cancelled = await agent.post(`/api/bookings/${held.body.data.id}/cancel`).expect(200);
      expect(cancelled.body.data.refundAmountMinor).toBe(104000);
      expect(cancelled.body.data.refunds[0]).toMatchObject({
        amountMinor: 104000,
        ticketMinor: 100000,
        platformFeeMinor: 2000,
        vatMinor: 2000,
      });
    } finally {
      await h.close();
    }
  });

  it('fee and VAT settings can be changed (e.g. 0) without touching existing bookings', async () => {
    const h = await createApiHarness({
      otpBypass: true,
      env: { PLATFORM_FEE_PER_SEAT_MINOR: '0', VAT_RATE_BPS: '750' },
    });
    try {
      const { eventId, seatIds } = await eventAt(h, 33333);
      const { agent } = await newCustomer(h);
      const quote = await agent
        .post('/api/bookings/quote')
        .send({ eventId, seatIds: [seatIds[0]] })
        .expect(200);
      expect(quote.body.data).toMatchObject({
        platformFeeMinor: 0,
        vatRateBps: 750,
        vatMinor: 2500,
        totalMinor: 35833,
      });
    } finally {
      await h.close();
    }
  });
});
