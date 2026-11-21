import { apiClient, type ApiClient } from '../../lib/apiClient';

export type Role = 'CUSTOMER' | 'ORGANIZER' | 'ADMIN';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  emailVerified: boolean;
  createdAt: string;
}

export interface RegisterPayload {
  name: string;
  email: string;
  password: string;
  role: 'CUSTOMER' | 'ORGANIZER';
}

/** Auth endpoints. The session lives in an httpOnly cookie the browser sends automatically. */
export function createAuthApi(client: ApiClient = apiClient) {
  return {
    async me(signal?: AbortSignal): Promise<User> {
      return (await client.get<{ user: User }>('/auth/me', { signal })).data.user;
    },
    async login(email: string, password: string): Promise<User> {
      return (await client.post<{ user: User }>('/auth/login', { email, password })).data.user;
    },
    async register(
      payload: RegisterPayload,
    ): Promise<{ user: User; verificationRequired: boolean }> {
      return (
        await client.post<{ user: User; verificationRequired: boolean }>('/auth/register', payload)
      ).data;
    },
    async verifyOtp(email: string, otp: string): Promise<User> {
      return (await client.post<{ user: User }>('/auth/verify-otp', { email, otp })).data.user;
    },
    async resendOtp(email: string): Promise<void> {
      await client.post('/auth/resend-otp', { email });
    },
    async logout(): Promise<void> {
      await client.post('/auth/logout');
    },
  };
}

export type AuthApi = ReturnType<typeof createAuthApi>;
export const authApi = createAuthApi();
