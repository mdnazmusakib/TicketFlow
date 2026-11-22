import { expect, test } from '@playwright/test';
import { DEMO, localDateTime, login, unique } from './helpers';

test.describe('Organizer journeys', () => {
  test('sign in, manage a venue and an event, publish it, see it in the catalogue', async ({
    page,
  }) => {
    await login(page, DEMO.organizer);
    await expect(page).toHaveURL(/\/organizer$/);
    await expect(page.getByRole('heading', { name: 'Organizer dashboard' })).toBeVisible();
    await expect(page.getByLabel('Sales totals')).toBeVisible();

    // Venue management.
    const venueName = unique('E2E Hall ');
    await page.goto('/organizer/venues');
    await page.getByLabel('Name').fill(venueName);
    await page.getByLabel('Address').fill('12 Test Road');
    await page.getByLabel('City').fill('Sylhet');
    await page.getByRole('button', { name: 'Add venue' }).click();
    await expect(page.getByText('Venue created')).toBeVisible();
    await expect(page.getByText(venueName).first()).toBeVisible();

    // Event creation (draft) with the default seat map.
    const title = unique('E2E Concert ');
    await page.goto('/organizer/events/new');
    await page.getByLabel('Title').fill(title);
    const venueOption = page.getByLabel('Venue').locator('option', { hasText: venueName });
    await page.getByLabel('Venue').selectOption((await venueOption.getAttribute('value'))!);
    await page.getByLabel('Starts').fill(localDateTime(20));
    await page.getByRole('button', { name: 'Create draft event' }).click();
    await expect(page).toHaveURL(/\/organizer\/events\/[0-9a-f-]{36}\/seats$/);
    await expect(page.getByRole('heading', { name: new RegExp(title) })).toContainText('DRAFT');

    // Publish from the dashboard list.
    await page.getByRole('link', { name: 'Back to events' }).click();
    const row = page
      .getByRole('listitem')
      .filter({ hasText: title })
      .filter({ has: page.getByRole('button', { name: 'Publish' }) });
    await row.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('Event published')).toBeVisible();
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: title })
        .filter({ hasText: 'PUBLISHED' })
        .first(),
    ).toBeVisible();

    // Public catalogue shows it.
    await page.goto('/events');
    await page.getByLabel('Search').fill(title);
    await expect(page.getByRole('link', { name: title })).toBeVisible();
  });

  test('booking overview for an event with sales', async ({ page }) => {
    await login(page, DEMO.organizer);
    await expect(page).toHaveURL(/\/organizer$/);
    const row = page.getByRole('listitem').filter({ hasText: 'Dhaka Live Music Night' }).last();
    await row.getByRole('link', { name: 'Bookings' }).click();
    await expect(page).toHaveURL(/\/organizer\/events\/[0-9a-f-]{36}\/bookings$/);
    await expect(page.getByRole('heading', { name: /Dhaka Live Music Night/ })).toBeVisible();
    await expect(page.getByLabel('Event sales')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Economy' })).toBeVisible();
    // The customer journey's booking is listed with a masked email only.
    await expect(page.getByText(/c\*+o@example\.com/).first()).toBeVisible();
    await expect(page.getByText('customer.demo@example.com')).toHaveCount(0);
  });
});
