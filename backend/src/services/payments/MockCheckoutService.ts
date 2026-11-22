import type { Actor } from '../../domain/auth/roles';
import type { MockProviderA } from '../../infrastructure/payments/MockProviders';
import { NotFoundError } from '../../shared/errors/AppError';
import type { PaymentService } from './PaymentService';
import type { WebhookService } from './WebhookService';

/**
 * Drives Mock Provider A's hosted checkout page. Completing the page makes the
 * mock provider send its signed webhook, which goes through the exact same
 * verification path as a real provider callback.
 */
export class MockCheckoutService {
  constructor(
    private readonly mockProviderA: MockProviderA | null,
    private readonly payments: PaymentService,
    private readonly webhooks: WebhookService,
  ) {}

  private async ownedMockPayment(actor: Actor, transactionRef: string) {
    const payment = await this.payments.findByTransactionRef(transactionRef);
    if (!this.mockProviderA || !payment || payment.provider !== 'MOCK_PROVIDER_A') {
      throw new NotFoundError('Payment not found');
    }
    return this.payments.loadOwned(actor, payment.id);
  }

  async view(actor: Actor, transactionRef: string) {
    const payment = await this.ownedMockPayment(actor, transactionRef);
    return this.payments.result(payment.id);
  }

  async complete(actor: Actor, transactionRef: string, outcome: 'success' | 'failure') {
    const payment = await this.ownedMockPayment(actor, transactionRef);
    const delivery = await this.mockProviderA!.completeCheckout(transactionRef, outcome);
    await this.webhooks.handle('MOCK_PROVIDER_A', {
      headers: delivery.headers,
      rawBody: delivery.rawBody,
      body: JSON.parse(delivery.rawBody.toString('utf8')) as unknown,
    });
    return this.payments.result(payment.id);
  }
}
