import { isRouteErrorResponse, Link, useRouteError } from 'react-router';

/** Router-level error element: 404s and errors thrown by route components/loaders. */
export function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  return (
    <div className="error-state" role="alert">
      <h1>{notFound ? 'Page not found' : 'Something went wrong'}</h1>
      <p>
        {notFound
          ? 'The page you are looking for does not exist.'
          : 'An unexpected error occurred.'}
      </p>
      <Link className="btn btn--primary" to="/">
        Back to home
      </Link>
    </div>
  );
}
