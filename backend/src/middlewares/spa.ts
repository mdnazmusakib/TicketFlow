import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';

/**
 * CSP for the web app's HTML/JS (the API keeps its own `default-src 'none'`).
 * Same-origin scripts/styles/API only; images may come from https (external
 * banners) and blob: (local previews). No inline script, no framing.
 */
export const FRONTEND_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Serves the built React app (single-host deployment): hashed assets are cached
 * for a year, every other non-API GET returns index.html (client-side routing).
 */
export function createFrontendRouter(distDir: string): Router {
  const root = path.resolve(distDir);
  const indexHtml = path.join(root, 'index.html');
  if (!existsSync(indexHtml)) {
    throw new Error(`FRONTEND_DIST_DIR has no index.html: ${root}`);
  }
  const router = express.Router();
  const setSecurityHeaders = (res: express.Response) => {
    res.setHeader('Content-Security-Policy', FRONTEND_CSP);
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  };

  router.use(
    express.static(root, {
      index: false,
      dotfiles: 'ignore',
      fallthrough: true,
      setHeaders: (res, filePath) => {
        setSecurityHeaders(res);
        const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
        res.setHeader(
          'Cache-Control',
          immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    }),
  );
  router.get(/^(?!\/api\/|\/uploads\/).*/, (req, res, next) => {
    if (!req.accepts('html')) {
      next();
      return;
    }
    setSecurityHeaders(res);
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
  return router;
}
