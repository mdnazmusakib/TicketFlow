import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ProviderRejectedError,
  ProviderUncertainError,
  type InitiatePaymentInput,
  type InitiatePaymentResult,
  type ParsedWebhook,
  type PaymentGateway,
  type RefundPaymentInput,
  type RefundPaymentResult,
  type RefundStatusInput,
  type VerifyPaymentInput,
  type VerifyPaymentResult,
  type WebhookRequest,
} from '../../domain/payments/PaymentGateway';

export interface SslCommerzConfig {
  storeId: string;
  storePassword: string;
  sandbox: boolean;
  /** Public base URL of this API (SSLCommerz posts IPN and browser returns here). */
  publicApiUrl: string;
  /** SSLCommerz requires a phone number; we do not collect one. */
  defaultCustomerPhone: string;
  timeoutMs?: number;
}

type FetchLike = typeof fetch;

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

/** Minor units -> "1234.50" (SSLCommerz expects decimal amounts). */
export function toDecimalAmount(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** "1234.50" -> 123450; NaN-safe. */
export function fromDecimalAmount(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : undefined;
}

/**
 * IPN signature check from the SSLCommerz integration guide: take the fields
 * listed in `verify_key`, add `store_passwd = md5(store password)`, sort by
 * key, join as `key=value&…`, md5 the string and compare with `verify_sign`.
 */
export function verifySslCommerzSignature(
  payload: Record<string, unknown>,
  storePassword: string,
): boolean {
  const verifyKey = payload.verify_key;
  const verifySign = payload.verify_sign;
  if (typeof verifyKey !== 'string' || typeof verifySign !== 'string' || verifyKey.length === 0)
    return false;
  const fields: Record<string, string> = {};
  for (const key of verifyKey.split(',')) {
    const value = payload[key];
    fields[key] = value === undefined || value === null ? '' : String(value);
  }
  fields.store_passwd = md5(storePassword);
  const hashString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('&');
  const expected = Buffer.from(md5(hashString));
  const actual = Buffer.from(verifySign);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * SSLCommerz (Bangladesh) adapter: hosted checkout session, IPN with
 * verify_sign, and the Order Validation API as the server-side source of
 * truth. Credentials come from environment variables only.
 */
export class SslCommerzAdapter implements PaymentGateway {
  readonly name = 'SSLCOMMERZ' as const;
  private readonly baseUrl: string;

  constructor(
    private readonly config: SslCommerzConfig,
    private readonly fetchImpl: FetchLike = (...args) => fetch(...args),
  ) {
    this.baseUrl = config.sandbox
      ? 'https://sandbox.sslcommerz.com'
      : 'https://securepay.sslcommerz.com';
  }

  callbackUrl(result: 'success' | 'fail' | 'cancel'): string {
    return `${this.config.publicApiUrl}/api/payments/providers/sslcommerz/return/${result}`;
  }

  ipnUrl(): string {
    return `${this.config.publicApiUrl}/api/payments/webhooks/SSLCOMMERZ`;
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    const form = new URLSearchParams({
      store_id: this.config.storeId,
      store_passwd: this.config.storePassword,
      total_amount: toDecimalAmount(input.amountMinor),
      currency: input.currency,
      tran_id: input.transactionRef,
      success_url: this.callbackUrl('success'),
      fail_url: this.callbackUrl('fail'),
      cancel_url: this.callbackUrl('cancel'),
      ipn_url: this.ipnUrl(),
      cus_name: input.customer.name,
      cus_email: input.customer.email,
      cus_add1: 'N/A',
      cus_city: 'Dhaka',
      cus_country: 'Bangladesh',
      cus_phone: this.config.defaultCustomerPhone,
      shipping_method: 'NO',
      num_of_item: '1',
      product_name: input.description.slice(0, 255),
      product_category: 'Event Ticket',
      product_profile: 'non-physical-goods',
      value_a: input.transactionRef,
    });

    let body: Record<string, unknown>;
    try {
      body = await this.request('/gwprocess/v4/api.php', { method: 'POST', body: form });
    } catch (error) {
      // No session was handed to the customer, so nothing can have been charged.
      throw new ProviderRejectedError(
        `SSLCommerz session could not be created: ${(error as Error).message}`,
      );
    }
    if (
      body.status !== 'SUCCESS' ||
      typeof body.GatewayPageURL !== 'string' ||
      !body.GatewayPageURL
    ) {
      throw new ProviderRejectedError(
        `SSLCommerz rejected the session: ${typeof body.failedreason === 'string' ? body.failedreason : 'unknown reason'}`,
      );
    }
    return {
      status: 'REDIRECT',
      redirectUrl: body.GatewayPageURL,
      metadata: { sessionkey: body.sessionkey },
    };
  }

  /**
   * Server-side validation. With a val_id (from IPN/return) the Order
   * Validation API is used; otherwise the transaction is looked up by tran_id.
   */
  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    let record: Record<string, unknown> | undefined;
    if (input.providerPaymentId) {
      record = await this.safeQuery('/validator/api/validationserverAPI.php', {
        val_id: input.providerPaymentId,
      });
    } else {
      const lookup = await this.safeQuery('/validator/api/merchantTransIDvalidationAPI.php', {
        tran_id: input.transactionRef,
      });
      const elements = Array.isArray(lookup.element)
        ? (lookup.element as Record<string, unknown>[])
        : [];
      record =
        elements.find((e) => e.status === 'VALID' || e.status === 'VALIDATED') ??
        elements.find((e) => e.status === 'PENDING') ??
        elements[0];
      if (!record) return { status: 'PENDING', failureReason: 'No transaction recorded yet' };
    }

    const status = String(record.status ?? '');
    const transactionRef = typeof record.tran_id === 'string' ? record.tran_id : undefined;
    if (transactionRef && transactionRef !== input.transactionRef) {
      return { status: 'FAILED', failureReason: 'Transaction reference mismatch' };
    }
    // currency_type/currency_amount carry the original (pre-conversion) values.
    const currency =
      typeof record.currency_type === 'string'
        ? record.currency_type
        : (record.currency as string | undefined);
    const amountMinor = fromDecimalAmount(record.currency_amount ?? record.amount);
    const metadata = {
      val_id: record.val_id,
      bank_tran_id: record.bank_tran_id,
      card_type: record.card_type,
      risk_level: record.risk_level,
    };
    const base = {
      ...(typeof record.val_id === 'string' ? { providerPaymentId: record.val_id } : {}),
      ...(amountMinor !== undefined ? { amountMinor } : {}),
      ...(currency ? { currency } : {}),
      metadata,
    };

    if (status === 'VALID' || status === 'VALIDATED') {
      if (String(record.risk_level ?? '0') === '1') {
        return {
          status: 'PENDING',
          ...base,
          failureReason: 'Flagged as high risk by SSLCommerz; manual review required',
        };
      }
      return { status: 'SUCCEEDED', ...base };
    }
    if (status === 'PENDING' || status === 'UNATTEMPTED' || status === '')
      return { status: 'PENDING', ...base };
    return { status: 'FAILED', ...base, failureReason: `SSLCommerz status ${status}` };
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const bankTranId = input.metadata?.bank_tran_id;
    if (typeof bankTranId !== 'string' || !bankTranId) {
      return { status: 'FAILED', failureReason: 'Missing bank_tran_id for refund' };
    }
    const body = await this.query('/validator/api/merchantTransIDvalidationAPI.php', {
      bank_tran_id: bankTranId,
      refund_amount: toDecimalAmount(input.amountMinor),
      refund_remarks: input.reason.slice(0, 255),
      refe_id: input.idempotencyKey.slice(0, 50),
    });
    const refId = typeof body.refund_ref_id === 'string' ? body.refund_ref_id : undefined;
    const status = String(body.status ?? '').toLowerCase();
    if (body.APIConnect !== 'DONE')
      return { status: 'FAILED', failureReason: `SSLCommerz API: ${String(body.APIConnect)}` };
    if (status === 'success' || status === 'processing') {
      return { status: 'PROCESSING', ...(refId ? { providerRefundId: refId } : {}) };
    }
    return {
      status: 'FAILED',
      failureReason: typeof body.errorReason === 'string' ? body.errorReason : 'Refund rejected',
    };
  }

  async refundStatus(input: RefundStatusInput): Promise<RefundPaymentResult> {
    const body = await this.query('/validator/api/merchantTransIDvalidationAPI.php', {
      refund_ref_id: input.providerRefundId,
    });
    const status = String(body.status ?? '').toLowerCase();
    if (status === 'refunded')
      return { status: 'SUCCEEDED', providerRefundId: input.providerRefundId };
    if (status === 'processing')
      return { status: 'PROCESSING', providerRefundId: input.providerRefundId };
    return {
      status: 'FAILED',
      providerRefundId: input.providerRefundId,
      failureReason: `Refund ${status || 'unknown'}`,
    };
  }

  parseWebhook(request: WebhookRequest): ParsedWebhook {
    const body = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<
      string,
      unknown
    >;
    const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : null);
    const transactionRef = str('tran_id');
    const valId = str('val_id');
    return {
      signatureValid: verifySslCommerzSignature(body, this.config.storePassword),
      eventId: `${valId ?? transactionRef ?? 'unknown'}:${str('status') ?? 'unknown'}`,
      eventType: `ipn.${(str('status') ?? 'unknown').toLowerCase()}`,
      transactionRef,
      providerPaymentId: valId,
      safePayload: {
        tran_id: transactionRef,
        val_id: valId,
        status: str('status'),
        amount: str('amount'),
        currency: str('currency'),
        bank_tran_id: str('bank_tran_id'),
        card_type: str('card_type'),
        risk_level: str('risk_level'),
        tran_date: str('tran_date'),
      },
    };
  }

  private async safeQuery(
    path: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.query(path, params);
    } catch (error) {
      if (error instanceof ProviderUncertainError) throw error;
      throw new ProviderUncertainError(
        `SSLCommerz validation failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  private query(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const search = new URLSearchParams({
      ...params,
      store_id: this.config.storeId,
      store_passwd: this.config.storePassword,
      format: 'json',
      v: '1',
    });
    return this.request(`${path}?${search.toString()}`, { method: 'GET' });
  }

  private async request(
    path: string,
    init: { method: 'GET' | 'POST'; body?: URLSearchParams },
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 20_000);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        ...(init.body
          ? { body: init.body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
          : {}),
        signal: controller.signal,
      });
      if (response.status >= 500)
        throw new ProviderUncertainError(`SSLCommerz HTTP ${response.status}`);
      if (!response.ok) throw new ProviderRejectedError(`SSLCommerz HTTP ${response.status}`);
      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ProviderRejectedError || error instanceof ProviderUncertainError)
        throw error;
      throw new ProviderUncertainError(`SSLCommerz unreachable: ${(error as Error).message}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
