import type { RouteObject } from 'react-router';
import { RouteError } from '../components/feedback/RouteError';
import { AppLayout } from '../components/layout/AppLayout';
import { AccountPage } from '../features/account/AccountPage';
import { AdminPage } from '../features/admin/AdminPage';
import { BookingDetailPage } from '../features/bookings/BookingDetailPage';
import { MyBookingsPage } from '../features/bookings/MyBookingsPage';
import { MockCheckoutPage } from '../features/payments/MockCheckoutPage';
import { PaymentResultPage } from '../features/payments/PaymentResultPage';
import { LoginPage } from '../features/auth/LoginPage';
import { ProtectedRoute } from '../features/auth/ProtectedRoute';
import { RegisterPage } from '../features/auth/RegisterPage';
import { VerifyOtpPage } from '../features/auth/VerifyOtpPage';
import { EventDetailPage } from '../features/events/EventDetailPage';
import { EventsPage } from '../features/events/EventsPage';
import { NotificationsPage } from '../features/notifications/NotificationsPage';
import { EventBookingsPage } from '../features/organizer/EventBookingsPage';
import { EventFormPage } from '../features/organizer/EventFormPage';
import { OrganizerEventsPage } from '../features/organizer/OrganizerEventsPage';
import { SeatMapPage } from '../features/organizer/SeatMapPage';
import { VenuesPage } from '../features/organizer/VenuesPage';
import { HomePage } from '../pages/HomePage';
import { NotFoundPage } from '../pages/NotFoundPage';

/** Route table. Protected areas are UX guards; the API enforces the real rules. */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'events', element: <EventsPage /> },
      { path: 'events/:id', element: <EventDetailPage /> },
      { path: 'login', element: <LoginPage /> },
      { path: 'register', element: <RegisterPage /> },
      { path: 'verify-email', element: <VerifyOtpPage /> },
      {
        element: <ProtectedRoute />,
        children: [
          { path: 'account', element: <AccountPage /> },
          { path: 'notifications', element: <NotificationsPage /> },
          { path: 'bookings', element: <MyBookingsPage /> },
          { path: 'bookings/:id', element: <BookingDetailPage /> },
          { path: 'payments/mock-checkout', element: <MockCheckoutPage /> },
          { path: 'payments/:id/result', element: <PaymentResultPage /> },
        ],
      },
      {
        path: 'organizer',
        element: <ProtectedRoute roles={['ORGANIZER', 'ADMIN']} />,
        children: [
          { index: true, element: <OrganizerEventsPage /> },
          { path: 'venues', element: <VenuesPage /> },
          { path: 'events/new', element: <EventFormPage /> },
          { path: 'events/:id/edit', element: <EventFormPage /> },
          { path: 'events/:id/seats', element: <SeatMapPage /> },
          { path: 'events/:id/bookings', element: <EventBookingsPage /> },
        ],
      },
      {
        path: 'admin',
        element: <ProtectedRoute roles={['ADMIN']} />,
        children: [{ index: true, element: <AdminPage /> }],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
