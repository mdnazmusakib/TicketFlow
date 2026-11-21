import { DemoCredentials } from '../features/auth/DemoCredentials';
import { SystemStatus } from '../features/system/SystemStatus';

export function HomePage() {
  return (
    <>
      <section className="hero">
        <h1>Book tickets for the events you love</h1>
        <p>Real-time seat holds, secure payments and instant confirmations.</p>
      </section>
      <div className="grid">
        <SystemStatus />
        <DemoCredentials />
      </div>
    </>
  );
}
