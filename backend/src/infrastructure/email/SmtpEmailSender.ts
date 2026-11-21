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
    await this.transporter.sendMail({ from: this.from, ...message });
  }
}
