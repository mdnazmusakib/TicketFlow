import { createBrowserRouter, RouterProvider } from 'react-router';
import { ErrorBoundary } from '../components/feedback/ErrorBoundary';
import { AuthProvider } from '../features/auth/AuthContext';
import { routes } from './routes';

const router = createBrowserRouter(routes);

export function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ErrorBoundary>
  );
}
