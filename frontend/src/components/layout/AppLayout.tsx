import { Outlet } from 'react-router';
import { Footer } from './Footer';
import { Header } from './Header';

export function AppLayout() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main" className="container main">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
