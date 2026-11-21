import { DEMO_ACCOUNTS, type DemoAccount } from './demoAccounts';

interface Props {
  accounts?: readonly DemoAccount[];
  /** Lets the login form prefill fields when a demo account is picked. */
  onSelect?: (account: DemoAccount) => void;
}

export function DemoCredentials({ accounts = DEMO_ACCOUNTS, onSelect }: Props) {
  return (
    <section className="card" aria-labelledby="demo-credentials-title">
      <h2 id="demo-credentials-title">Demo accounts</h2>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Email</th>
            <th scope="col">Password</th>
            {onSelect && (
              <th scope="col">
                <span className="visually-hidden">Action</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.email}>
              <td>{account.role}</td>
              <td>
                <code>{account.email}</code>
              </td>
              <td>
                <code>{account.password}</code>
              </td>
              {onSelect && (
                <td>
                  <button type="button" className="link-button" onClick={() => onSelect(account)}>
                    Use
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
