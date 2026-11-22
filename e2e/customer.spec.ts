import { expect, test } from '@playwright/test';
import { DEMO, login, logout, unique, waitForMail } from './helpers';

test.describe('Customer journeys', () => {
  test('registration with email OTP, then sign out and sign back in', async ({ page }) => {
    const email = `${unique('e2e.customer.')}@example.com`;
    const password = 'Str0ng!Passw0rd';

    await page.goto('/register');
    await page.getByLabel('Full name').fill('E2E Customer');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByLabel('I want to').selectOption('CUSTOMER');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(/\/verify-email/);
    const mail = await waitForMail(email, /code|verify/i);
    const otp = /\b(\d{6})\b/.exec(mail.text)?.[1];
    expect(otp, 'OTP in the verification email').toBeTruthy();

    // A wrong code is rejected first.
    await page.getByLabel('Verification code').fill(otp === '000000' ? '111111' : '000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('alert')).toBeVisible();

    await page.getByLabel('Verification code').fill(otp!);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole('heading', { name: 'My dashboard' })).toBeVisible();

    await logout(page);
    await login(page, { email, password });
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByText(email)).toBeVisible();
  });

  test('wrong password is rejected without revealing which field was wrong', async ({ page }) => {
    await login(page, { email: DEMO.customer.email, password: 'Wrong!Passw0rd' });
    await expect(page.getByRole('alert')).toContainText(/invalid email or password/i);
    await expect(page).toHaveURL(/\/login/);
  });

  test('discover an event, hold seats, pay, get confirmation, cancel with full refund', async ({
    page,
  }) => {
    await login(page, DEMO.customer);
    await expect(page).toHaveURL(/\/account$/);

    // Discovery: search and open the event.
    await page.goto('/events');
    await page.getByLabel('Search').fill('Dhaka Live');
    await expect(page.getByRole('link', { name: 'Dhaka Live Music Night' })).toBeVisible();
    await page.getByRole('link', { name: 'Dhaka Live Music Night' }).click();
    await expect(page.getByRole('heading', { name: 'Dhaka Live Music Night' })).toBeVisible();

    // Seat selection: two free economy seats (row H).
    const free = page
      .getByRole('grid', { name: 'Seat map' })
      .locator('button[aria-label^="Row H seat"]:not([aria-label$="unavailable"])');
    await expect(free.first()).toBeVisible();
    await free.nth(0).click();
    await free.nth(1).click();
    const summary = page.getByRole('complementary', { name: 'Booking summary' });
    await expect(summary).toContainText('Economy');
    await page.getByRole('button', { name: /Hold 2 seat\(s\) for 5 minutes/ }).click();

    // Booking page with countdown.
    await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
    await expect(page.locator('.badge', { hasText: 'Seats held' })).toBeVisible();

    // Payment success (Mock Provider B, card that succeeds).
    await page.getByLabel(/Saved card · Mock Provider B/).check();
    await page.getByLabel('Test card').selectOption('tok_success');
    await page.getByRole('button', { name: /^Pay / }).click();
    await expect(page.locator('.badge', { hasText: 'Confirmed' })).toBeVisible();

    // Confirmation email + in-app notification.
    const confirmation = await waitForMail(
      DEMO.customer.email,
      /Your TicketFlow tickets: Dhaka Live/,
    );
    expect(confirmation.text).toContain('Seats: Row H');
    await page.goto('/notifications');
    await expect(page.getByText('Booking confirmed').first()).toBeVisible();
    await page.goBack();

    // Cancellation: event is weeks away, so the preview promises a full refund.
    await page.getByRole('button', { name: 'Cancel booking' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm cancellation' });
    await expect(dialog).toContainText('full refund');
    await dialog.getByRole('button', { name: 'Confirm cancellation' }).click();
    await expect(page.locator('.badge', { hasText: 'Cancelled' })).toBeVisible();
    await expect(page.getByText(/refund/i).first()).toBeVisible();
    await waitForMail(DEMO.customer.email, /Booking cancelled: Dhaka Live/);
  });

  test('a customer cannot open organizer pages', async ({ page }) => {
    await login(page, DEMO.customer);
    await expect(page).toHaveURL(/\/account$/);
    await page.goto('/organizer');
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  });
});
