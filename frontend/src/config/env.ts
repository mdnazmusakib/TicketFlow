/** The only module that touches import.meta.env (swapped for a plain module in Jest). */
const rawBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api';

export const env = {
  apiBaseUrl: rawBaseUrl.replace(/\/+$/, ''),
  isDev: import.meta.env.DEV,
} as const;
