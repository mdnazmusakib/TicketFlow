import dotenv from 'dotenv';
import { loadConfig } from '../../config/env';
import { createLogger } from '../../config/logger';
import { Database } from '../../infrastructure/database/Database';
import { createPool } from '../../infrastructure/database/pool';
import { BcryptPasswordHasher } from '../../infrastructure/security/PasswordHasher';
import { UserRepository } from '../../repositories/UserRepository';
import { AdminAccountService } from '../../services/admin/AdminAccountService';

const USAGE = `Usage (from the repository root):
  npm run admin -w backend -- list
  npm run admin -w backend -- promote <email>        grant ADMIN to an existing account
  npm run admin -w backend -- set-password <email>   new password from ADMIN_NEW_PASSWORD
  npm run admin -w backend -- deactivate <email>     refuses the last active admin
  npm run admin -w backend -- activate <email>
The database is the one in DATABASE_URL (backend/.env or the shell environment).`;

/** Operator CLI for admin accounts. Passwords are read from the environment, never printed. */
async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  const [command, email] = process.argv.slice(2);
  if (!command || (command !== 'list' && !email)) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(command ? 1 : 0);
  }
  const config = loadConfig();
  const logger = createLogger(config);
  const db = new Database(createPool(config.database, logger), logger);
  const admins = new AdminAccountService(
    db,
    new UserRepository(db),
    new BcryptPasswordHasher(config.auth.bcryptSaltRounds),
  );
  const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

  try {
    switch (command) {
      case 'list':
        out(await admins.listAdmins());
        break;
      case 'promote':
        out(await admins.promote(email!));
        break;
      case 'set-password': {
        const password = process.env.ADMIN_NEW_PASSWORD;
        if (!password) throw new Error('Set ADMIN_NEW_PASSWORD in the environment first');
        await admins.setPassword(email!, password);
        out({ email: email!.toLowerCase(), passwordChanged: true });
        break;
      }
      case 'deactivate':
        out(await admins.setActive(email!, false));
        break;
      case 'activate':
        out(await admins.setActive(email!, true));
        break;
      default:
        process.stdout.write(`${USAGE}\n`);
        process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
