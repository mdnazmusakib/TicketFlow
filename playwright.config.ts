import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4100);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * End-to-end journeys against the full stack started by `npm run e2e:server -w backend`
 * (embedded PostgreSQL + seeded demo data, in-memory Redis, real OTP via a mailbox file,
 * and the built web app served by the API). Build the frontend first: `npm run build -w frontend`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // journeys share one seeded database
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run e2e:server -w backend',
        url: `${baseURL}/api/health/ready`,
        timeout: 180_000,
        reuseExistingServer: !process.env.CI,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { E2E_PORT: String(PORT) },
      },
});
