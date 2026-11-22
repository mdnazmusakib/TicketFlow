/** Outgoing email. Implementations: console (dev), SMTP (production), in-memory (tests). */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Stable id for this logical message; providers can use it to drop duplicates on retries. */
  idempotencyKey?: string;
}

/** Email delivery abstraction (DIP): services never depend on a concrete mailer. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function otpEmail(params: {
  name: string;
  code: string;
  ttlMinutes: number;
}): Omit<EmailMessage, 'to'> {
  const { name, code, ttlMinutes } = params;
  return {
    subject: 'Your TicketFlow verification code',
    text: [
      `Hi ${name},`,
      '',
      `Your TicketFlow verification code is ${code}.`,
      `It expires in ${ttlMinutes} minutes and can be used once.`,
      '',
      'If you did not create an account, you can ignore this email.',
    ].join('\n'),
    html: `<p>Hi ${escapeHtml(name)},</p><p>Your TicketFlow verification code is <strong>${code}</strong>.</p><p>It expires in ${ttlMinutes} minutes and can be used once.</p><p>If you did not create an account, you can ignore this email.</p>`,
  };
}
