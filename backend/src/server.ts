import dotenv from 'dotenv';
import type { Server } from 'node:http';
import { createApp } from './app';
import { ConfigError, loadConfig } from './config/env';
import { createLogger } from './config/logger';
import { buildContainer } from './container';

async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Logger is not configured yet; message lists variable names only, never values.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config);
  const container = buildContainer(config, logger);

  try {
    await container.start();
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to connect to PostgreSQL/Redis during startup');
    await container.close();
    process.exit(1);
  }

  const app = createApp({
    config,
    logger,
    controllers: container.controllers,
    authenticate: container.authenticate,
  });
  const server: Server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, 'TicketFlow API listening');
  });
  container.expiryWorker.start();
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const forceExit = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    server.close(() => {
      void container.close().then(() => {
        logger.info('Shutdown complete');
        process.exit(0);
      });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    shutdown('uncaughtException');
  });
}

void main();
