/**
 * Public demo credentials created by `npm run db:seed` (also listed in README.md).
 * Shown on the login screen so reviewers can sign in as each role.
 */
export interface DemoAccount {
  role: 'Organizer' | 'Customer' | 'Admin';
  email: string;
  password: string;
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { role: 'Organizer', email: 'organizer.demo@example.com', password: 'Organizer@123' },
  { role: 'Customer', email: 'customer.demo@example.com', password: 'Customer@123' },
  { role: 'Admin', email: 'admin.demo@example.com', password: 'Admin@12345' },
];
