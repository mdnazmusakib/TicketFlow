import { createHash } from 'node:crypto';
import { SslCommerzAdapter } from '../../src/infrastructure/payments/SslCommerzAdapter';

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

export const SSL_STORE = { storeId: 'testbox', storePassword: 'qwerty@ssl' };

interface Session {
  tranId: string;
  amount: string;
  currency: string;
  status: 'PENDING' | 'VALID' | 'FAILED';
  valId: string;
  bankTranId: string;
  riskLevel: string;
  reportedAmount?: string;
}

/**
 * In-memory stand-in for the SSLCommerz sandbox HTTP API (session, Order
 * Validation, transaction query, refund, refund status). Lets tests exercise
 * the real adapter end-to-end without network access or credentials.
 */
export class FakeSslCommerz {
  readonly sessions = new Map<string, Session>();
  readonly calls: string[] = [];
  refundCalls = 0;
  failValidation = false;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    this.calls.push(url.pathname);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (url.pathname === '/gwprocess/v4/api.php') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      if (form.get('store_passwd') !== SSL_STORE.storePassword)
        return json({ status: 'FAILED', failedreason: 'Store Credential Error' });
      const tranId = form.get('tran_id')!;
      this.sessions.set(tranId, {
        tranId,
        amount: form.get('total_amount')!,
        currency: form.get('currency')!,
        status: 'PENDING',
        valId: `val${tranId.slice(-10)}`,
        bankTranId: `bank${tranId.slice(-10)}`,
        riskLevel: '0',
      });
      return json({
        status: 'SUCCESS',
        sessionkey: `sess_${tranId}`,
        GatewayPageURL: `https://sandbox.sslcommerz.com/gwprocess/v4/gw.php?Q=pay&SESSIONKEY=sess_${tranId}`,
      });
    }

    if (this.failValidation) return json({ error: 'down' }, 503);

    if (url.pathname === '/validator/api/validationserverAPI.php') {
      const session = [...this.sessions.values()].find(
        (s) => s.valId === url.searchParams.get('val_id'),
      );
      if (!session) return json({ status: 'INVALID_TRANSACTION' });
      return json(this.record(session));
    }

    if (url.pathname === '/validator/api/merchantTransIDvalidationAPI.php') {
      if (url.searchParams.get('refund_amount')) {
        this.refundCalls += 1;
        return json({
          APIConnect: 'DONE',
          status: 'success',
          refund_ref_id: `ref_${url.searchParams.get('refe_id')}`,
        });
      }
      if (url.searchParams.get('refund_ref_id'))
        return json({ APIConnect: 'DONE', status: 'refunded' });
      const session = this.sessions.get(url.searchParams.get('tran_id') ?? '');
      return json({
        APIConnect: 'DONE',
        no_of_trans_found: session ? 1 : 0,
        element: session ? [this.record(session)] : [],
      });
    }
    return json({ error: 'not found' }, 404);
  };

  private record(session: Session) {
    return {
      status: session.status,
      tran_id: session.tranId,
      val_id: session.valId,
      amount: session.reportedAmount ?? session.amount,
      currency: 'BDT',
      currency_type: session.currency,
      currency_amount: session.reportedAmount ?? session.amount,
      bank_tran_id: session.bankTranId,
      card_type: 'VISA-Dutch Bangla',
      risk_level: session.riskLevel,
    };
  }

  /** Simulates the customer completing payment on the SSLCommerz page. */
  pay(
    tranId: string,
    overrides: Partial<Pick<Session, 'riskLevel' | 'reportedAmount' | 'status'>> = {},
  ): Session {
    const session = this.sessions.get(tranId);
    if (!session) throw new Error(`No session for ${tranId}`);
    Object.assign(session, { status: 'VALID' }, overrides);
    return session;
  }

  /** Builds an IPN body signed exactly like SSLCommerz (verify_key / verify_sign). */
  ipn(
    tranId: string,
    status = 'VALID',
    storePassword = SSL_STORE.storePassword,
  ): Record<string, string> {
    const session = this.sessions.get(tranId)!;
    const body: Record<string, string> = {
      tran_id: tranId,
      val_id: session.valId,
      amount: session.amount,
      card_type: 'VISA-Dutch Bangla',
      store_amount: session.amount,
      bank_tran_id: session.bankTranId,
      status,
      currency: session.currency,
      store_id: SSL_STORE.storeId,
      risk_level: session.riskLevel,
    };
    body.verify_key =
      'amount,bank_tran_id,card_type,currency,risk_level,status,store_amount,store_id,tran_id,val_id';
    const fields: Record<string, string> = {};
    for (const key of body.verify_key.split(',')) fields[key] = body[key]!;
    fields.store_passwd = md5(storePassword);
    body.verify_sign = md5(
      Object.keys(fields)
        .sort()
        .map((key) => `${key}=${fields[key]}`)
        .join('&'),
    );
    return body;
  }

  adapter(): SslCommerzAdapter {
    return new SslCommerzAdapter(
      {
        ...SSL_STORE,
        sandbox: true,
        publicApiUrl: 'http://localhost:4000',
        defaultCustomerPhone: '01700000000',
      },
      this.fetch,
    );
  }
}
