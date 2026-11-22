import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

export const MAILBOX = path.resolve(
  process.env.E2E_MAILBOX ?? path.join(__dirname, '..', 'backend', '.tmp', 'e2e-mailbox.jsonl'),
);

export const DEMO = {
  organizer: { email: 'organizer.demo@example.com', password: 'Organizer@123' },
  customer: { email: 'customer.demo@example.com', password: 'Customer@123' },
} as const;

interface MailItem {
  to: string;
  subject: string;
  text: string;
}

export function mails(to: string): MailItem[] {
  if (!existsSync(MAILBOX)) return [];
  return readFileSync(MAILBOX, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MailItem)
    .filter((mail) => mail.to === to.toLowerCase());
}

/** Waits for an email (sent by the outbox worker) and returns it. */
export async function waitForMail(to: string, subject: RegExp): Promise<MailItem> {
  let found: MailItem | undefined;
  await expect
    .poll(
      () => {
        found = mails(to).find((mail) => subject.test(mail.subject));
        return Boolean(found);
      },
      { timeout: 20_000, message: `email "${subject}" to ${to}` },
    )
    .toBe(true);
  return found!;
}

export async function login(page: Page, account: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function logout(page: Page) {
  await page.getByRole('button', { name: /Sign out/ }).click();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
}

/** <input type="datetime-local"> value for a moment `days` from now (local time). */
export function localDateTime(days: number, hour = 19): string {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setHours(hour, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}

export const unique = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
