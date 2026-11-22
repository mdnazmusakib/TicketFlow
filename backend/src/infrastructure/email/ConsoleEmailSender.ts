import type { EmailMessage, EmailSender } from '../../domain/notifications/email';

/**
 * Development mailbox: prints emails to stdout so OTPs can be read locally.
 * Bypasses the structured logger on purpose (its redaction would hide the
 * code). Configuration forbids this transport in production.
 */
export class ConsoleEmailSender implements EmailSender {
  constructor(
    private readonly from: string,
    private readonly write: (text: string) => void = (text) => process.stdout.write(text),
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const line = '-'.repeat(60);
    this.write(
      `\n${line}\n[DEV MAIL] from: ${this.from}\nto: ${message.to}\nsubject: ${message.subject}\n\n${message.text}\n${line}\n`,
    );
  }
}
