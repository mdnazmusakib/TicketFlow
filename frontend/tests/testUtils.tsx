import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { AuthProvider } from '../src/features/auth/AuthContext';
import type { AuthApi, User } from '../src/features/auth/authApi';
import { ApiError } from '../src/lib/apiClient';

export const organizerUser: User = {
  id: 'u-org',
  name: 'Olivia Organizer',
  email: 'olivia@example.com',
  role: 'ORGANIZER',
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

export const customerUser: User = {
  ...organizerUser,
  id: 'u-cus',
  name: 'Cara Customer',
  email: 'cara@example.com',
  role: 'CUSTOMER',
};

const unauthorized = () =>
  Promise.reject(new ApiError(401, 'UNAUTHORIZED', 'Authentication required'));

/** Fake auth API; every method is a jest.fn so tests can assert calls and override results. */
export function fakeAuthApi(current: User | null = null): jest.Mocked<AuthApi> {
  return {
    me: jest.fn(() => (current ? Promise.resolve(current) : unauthorized())),
    login: jest.fn(),
    register: jest.fn(),
    verifyOtp: jest.fn(),
    resendOtp: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AuthApi>;
}

export const anonymousAuthApi = () => fakeAuthApi(null);

/**
 * Renders `element` at `path` inside a memory router + AuthProvider. Extra
 * routes let tests assert where navigation ended up.
 */
interface RenderRouteOptions {
  path?: string;
  at?: string;
  auth?: AuthApi;
  extra?: RouteObject[];
}

export function renderRoute(element: ReactElement, options: RenderRouteOptions = {}) {
  const { path = '/', auth = anonymousAuthApi(), extra = [] } = options;
  const at = options.at ?? path;
  const routes: RouteObject[] = [
    { path, element },
    ...extra,
    { path: '*', element: <p>Landed on fallback</p> },
  ];
  const router = createMemoryRouter(routes, { initialEntries: [at] });
  const utils = render(
    <AuthProvider api={auth}>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
  return { ...utils, router, auth };
}
