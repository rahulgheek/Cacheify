'use strict';

/**
 * Express application assembly. API-only: the frontend lives in ../frontend
 * (Next.js) and is served by its own dev server or CDN host. Listen happens
 * in index.js.
 */

const express = require('express');

const { config } = require('./core/env');
const middleware = require('./core/middleware');
const phaseTimer = require('./core/phase-timer');

const authRoutes = require('./modules/auth/route');
const databasesRoutes = require('./modules/databases/route');
const apiKeysRoutes = require('./modules/apikeys/route');
const dataRoutes = require('./modules/data/route');
const usersRoutes = require('./modules/users/route');
const profileRoutes = require('./modules/profile/route');

/* Strict CORS boundary for cross-origin browser clients (Next.js frontend).
   Exact-match origin allowlist, no credentials (session tokens travel in the
   Authorization header, never cookies). Requests without an Origin header
   (curl, tests, server-to-server agents) are unrestricted. */
function corsMiddleware(req, res, next) {
  const origin = String(req.headers.origin || '').toLowerCase();
  if (!origin || !config.corsOrigins.includes(origin)) return next();

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  return next();
}

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Request-scoped phase timing context: every awaited subsystem underneath
  // (remote Redis, engine) attributes durations here; envelope + error paths
  // surface it as Server-Timing.
  app.use(phaseTimer.open);

  // API-only security headers (no HTML is served from this process; the
  // frontend ships its own strict headers from Next.js).
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(corsMiddleware);

  app.use(express.json({
    limit: config.bodyLimitBytes,
    strict: true,
  }));
  app.use(middleware.requestContext);
  app.use(middleware.attachUser);

  // API surface
  app.use('/api/auth', authRoutes);
  // Databases, API keys and the data plane require a verified email from new
  // accounts (grandfathered users and admins pass: email_verified defaults 1).
  app.use('/api/databases', middleware.requireVerifiedEmail, databasesRoutes);
  app.use('/api/api-keys', middleware.requireVerifiedEmail, apiKeysRoutes);
  app.use('/api/data', middleware.requireVerifiedEmail, dataRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/profile', profileRoutes);

  // Machine-readable contracts (AX): index for agents.
  app.get('/llms.txt', (_req, res) => {
    res.type('text/plain').send(require('./openapi').llmsTxt());
  });
  app.get('/api/openapi.json', (_req, res) => {
    res.json(require('./openapi').spec());
  });

  app.use(middleware.notFoundHandler);
  app.use(middleware.errorHandler);
  return app;
}

module.exports = { buildApp };
