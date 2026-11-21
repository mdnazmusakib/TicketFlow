import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError } from '../../lib/apiClient';
import { authApi as defaultApi, type AuthApi, type RegisterPayload, type User } from './authApi';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  login(email: string, password: string): Promise<User>;
  register(payload: RegisterPayload): Promise<{ user: User; verificationRequired: boolean }>;
  verifyOtp(email: string, otp: string): Promise<User>;
  resendOtp(email: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Holds the current user for rendering decisions only. Real authorization is
 * enforced by the API on every request; the UI never trusts this state for security.
 */
export function AuthProvider({
  children,
  api = defaultApi,
}: {
  children: ReactNode;
  api?: AuthApi;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    const controller = new AbortController();
    api.me(controller.signal).then(
      (current) => {
        setUser(current);
        setStatus('authenticated');
      },
      (error: unknown) => {
        if (error instanceof ApiError && error.code === 'REQUEST_ABORTED') return;
        setUser(null);
        setStatus('anonymous');
      },
    );
    return () => controller.abort();
  }, [api]);

  const signIn = useCallback((next: User) => {
    setUser(next);
    setStatus('authenticated');
    return next;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      login: async (email, password) => signIn(await api.login(email, password)),
      register: async (payload) => {
        const result = await api.register(payload);
        if (!result.verificationRequired) signIn(result.user);
        return result;
      },
      verifyOtp: async (email, otp) => signIn(await api.verifyOtp(email, otp)),
      resendOtp: (email) => api.resendOtp(email),
      logout: async () => {
        try {
          await api.logout();
        } finally {
          setUser(null);
          setStatus('anonymous');
        }
      },
    }),
    [api, signIn, status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
