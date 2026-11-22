import nodemailer, { type Transporter } from 'nodemailer';
import type { AppConfig } from '../../config/env';
import type { EmailMessage, EmailSender } from '../../domain/notifications/email';

type SmtpConfig = NonNullable<AppConfig['email']['smtp']>;

/** Production mailer (any SMTP provider). */
export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;

  constructor(
    smtp: SmtpConfig,
    private readonly from: string,
  ) {
    this.transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user && smtp.pass ? { auth: { user: smtp.user, pass: smtp.pass } } : {}),
    });
  }

  async send(message: EmailMessage): Promise<void> {
    const { idempotencyKey, ...content } = message;
    await this.transporter.sendMail({
      from: this.from,
      ...content,
      // A stable Message-ID lets receiving servers collapse a retried duplicate.
      ...(idempotencyKey
        ? { messageId: `<${idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '.')}@ticketflow>` }
        : {}),
    });
  }
}
