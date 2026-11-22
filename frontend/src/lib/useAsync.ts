import { useCallback, useEffect, useRef, useState } from 'react';

export type AsyncState<T> =
  | { status: 'loading'; data?: undefined; error?: undefined }
  | { status: 'success'; data: T; error?: undefined }
  | { status: 'error'; data?: undefined; error: unknown };

/**
 * Runs an abortable async loader on mount and whenever `key` changes;
 * `reload` re-runs it. Stale results are ignored.
 */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  key = '',
): AsyncState<T> & { reload: () => void; refresh: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [lastKey, setLastKey] = useState(key);
  // Reset to loading during render when the key changes (React's "adjust state on prop change" pattern).
  if (lastKey !== key) {
    setLastKey(key);
    setState({ status: 'loading' });
  }
  const loaderRef = useRef(loader);

  // Declared first so the latest loader is in place before the fetch effect runs.
  useEffect(() => {
    loaderRef.current = loader;
  });

  useEffect(() => {
    const controller = new AbortController();
    loaderRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: 'success', data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', error });
      },
    );
    return () => controller.abort();
  }, [attempt, key]);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  /** Re-fetches without resetting to "loading" (keeps showing current data). */
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  return { ...state, reload, refresh };
}
