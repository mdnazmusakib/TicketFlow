import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from '../src/features/auth/LoginPage';
import { ProtectedRoute, safeNextPath } from '../src/features/auth/ProtectedRoute';
import { RegisterPage } from '../src/features/auth/RegisterPage';
import { VerifyOtpPage } from '../src/features/auth/VerifyOtpPage';
import { ApiError } from '../src/lib/apiClient';
import { customerUser, fakeAuthApi, organizerUser, renderRoute } from './testUtils';

describe('LoginPage', () => {
  it('signs in and sends organizers to their dashboard', async () => {
    const auth = fakeAuthApi();
    auth.login.mockResolvedValue(organizerUser);
    renderRoute(<LoginPage />, {
      path: '/login',
      auth,
      extra: [{ path: '/organizer', element: <p>Organizer home</p> }],
    });

    await userEvent.type(screen.getByLabelText('Email'), ' olivia@example.com ');
    await userEvent.type(screen.getByLabelText('Password'), 'Str0ng!Pass');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Organizer home')).toBeInTheDocument();
    expect(auth.login).toHaveBeenCalledWith('olivia@example.com', 'Str0ng!Pass');
  });

  it('honours a safe ?next= redirect and ignores external ones', async () => {
    const auth = fakeAuthApi();
    auth.login.mockResolvedValue(customerUser);
    renderRoute(<LoginPage />, {
      path: '/login',
      at: '/login?next=//evil.example.com',
      auth,
      extra: [{ path: '/account', element: <p>Account page</p> }],
    });
    await userEvent.type(screen.getByLabelText('Email'), 'cara@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Account page')).toBeInTheDocument();
  });

  it('shows the generic error for bad credentials', async () => {
    const auth = fakeAuthApi();
    auth.login.mockRejectedValue(
      new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password'),
    );
    renderRoute(<LoginPage />, { path: '/login', auth });
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });

  it('routes unverified accounts to email verification', async () => {
    const auth = fakeAuthApi();
    auth.login.mockRejectedValue(new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email'));
    renderRoute(<LoginPage />, {
      path: '/login',
      auth,
      extra: [{ path: '/verify-email', element: <p>Verify page</p> }],
    });
    await userEvent.type(screen.getByLabelText('Email'), 'new@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Str0ng!Pass');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Verify page')).toBeInTheDocument();
  });

  it('prefills demo credentials', async () => {
    renderRoute(<LoginPage />, { path: '/login' });
    await userEvent.click(screen.getAllByRole('button', { name: 'Use' })[0]!);
    expect(screen.getByLabelText('Email')).toHaveValue('organizer.demo@example.com');
    expect(screen.getByLabelText('Password')).toHaveValue('Organizer@123');
  });
});

describe('RegisterPage', () => {
  it('checks password strength before calling the API', async () => {
    const auth = fakeAuthApi();
    renderRoute(<RegisterPage />, { path: '/register', auth });
    await userEvent.type(screen.getByLabelText('Full name'), 'New Person');
    await userEvent.type(screen.getByLabelText('Email'), 'new@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'weakpass');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(
      screen.getByText(/Password needs an uppercase letter, a digit, a symbol/),
    ).toBeInTheDocument();
    expect(auth.register).not.toHaveBeenCalled();
  });

  it('registers an organizer and continues to OTP verification', async () => {
    const auth = fakeAuthApi();
    auth.register.mockResolvedValue({
      user: { ...organizerUser, emailVerified: false },
      verificationRequired: true,
    });
    renderRoute(<RegisterPage />, {
      path: '/register',
      auth,
      extra: [{ path: '/verify-email', element: <p>Verify page</p> }],
    });
    await userEvent.type(screen.getByLabelText('Full name'), 'Olivia Organizer');
    await userEvent.type(screen.getByLabelText('Email'), 'olivia@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Str0ng!Pass');
    await userEvent.selectOptions(screen.getByLabelText('I want to'), 'ORGANIZER');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Verify page')).toBeInTheDocument();
    expect(auth.register).toHaveBeenCalledWith({
      name: 'Olivia Organizer',
      email: 'olivia@example.com',
      password: 'Str0ng!Pass',
      role: 'ORGANIZER',
    });
  });

  it('shows server-side field errors such as a taken email', async () => {
    const auth = fakeAuthApi();
    auth.register.mockRejectedValue(
      new ApiError(409, 'EMAIL_TAKEN', 'An account with this email already exists'),
    );
    renderRoute(<RegisterPage />, { path: '/register', auth });
    await userEvent.type(screen.getByLabelText('Full name'), 'Dup');
    await userEvent.type(screen.getByLabelText('Email'), 'dup@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Str0ng!Pass');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
  });
});

describe('VerifyOtpPage', () => {
  it('verifies the code and signs the user in', async () => {
    const auth = fakeAuthApi();
    auth.verifyOtp.mockResolvedValue(customerUser);
    renderRoute(<VerifyOtpPage />, {
      path: '/verify-email',
      at: '/verify-email?email=cara%40example.com',
      auth,
      extra: [{ path: '/account', element: <p>Account page</p> }],
    });
    expect(screen.getByLabelText('Email')).toHaveValue('cara@example.com');
    const verify = screen.getByRole('button', { name: 'Verify' });
    expect(verify).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Verification code'), '12a3456');
    expect(screen.getByLabelText('Verification code')).toHaveValue('123456');
    await userEvent.click(verify);
    expect(await screen.findByText('Account page')).toBeInTheDocument();
    expect(auth.verifyOtp).toHaveBeenCalledWith('cara@example.com', '123456');
  });

  it('explains expired codes and allows resending after login redirect', async () => {
    const auth = fakeAuthApi();
    auth.verifyOtp.mockRejectedValue(
      new ApiError(400, 'OTP_EXPIRED', 'Verification code expired. Request a new one.'),
    );
    renderRoute(<VerifyOtpPage />, {
      path: '/verify-email',
      at: '/verify-email?email=x%40example.com&resend=1',
      auth,
    });
    await userEvent.type(screen.getByLabelText('Verification code'), '111111');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('expired');
    expect(screen.getByLabelText('Verification code')).toHaveValue('');

    await userEvent.click(screen.getByRole('button', { name: 'Resend code' }));
    expect(auth.resendOtp).toHaveBeenCalledWith('x@example.com');
    expect(await screen.findByRole('button', { name: /Resend in \d+s/ })).toBeDisabled();
  });
});

describe('ProtectedRoute', () => {
  it('redirects anonymous visitors to login with a return path', async () => {
    renderRoute(<ProtectedRoute roles={['ORGANIZER']}>secret</ProtectedRoute>, {
      path: '/organizer',
      extra: [{ path: '/login', element: <p>Login screen</p> }],
    });
    expect(await screen.findByText('Login screen')).toBeInTheDocument();
  });

  it('denies signed-in users without the role', async () => {
    renderRoute(<ProtectedRoute roles={['ORGANIZER', 'ADMIN']}>secret</ProtectedRoute>, {
      path: '/organizer',
      auth: fakeAuthApi(customerUser),
    });
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('renders content for allowed roles', async () => {
    renderRoute(<ProtectedRoute roles={['ORGANIZER']}>secret area</ProtectedRoute>, {
      path: '/organizer',
      auth: fakeAuthApi(organizerUser),
    });
    await waitFor(() => expect(screen.getByText('secret area')).toBeInTheDocument());
  });

  it('safeNextPath blocks open redirects', () => {
    expect(safeNextPath('/organizer/venues')).toBe('/organizer/venues');
    expect(safeNextPath('//evil.com')).toBe('/');
    expect(safeNextPath('https://evil.com')).toBe('/');
    expect(safeNextPath('/\\evil.com', '/x')).toBe('/x');
    expect(safeNextPath(null, '/account')).toBe('/account');
  });
});
