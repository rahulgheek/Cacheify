'use strict';

/**
 * Fail-fast environment configuration (core).
 * All runtime configuration is validated against a strict schema at startup.
 * In production, missing required secrets crash the process immediately.
 */

const dotenv = require('dotenv');
const fs = require('node:fs');
const path = require('node:path');

function loadDotFile() {
  // Load .env using dotenv (handles quotes, comments, multiline, etc.).
  // OS-level / explicitly set env vars ALWAYS win, even when set to '' —
  // callers (smoke tests, mail MOCK mode) use empty strings to neutralize
  // .env values on purpose. Only absent keys are filled from .env.
  const envPath = path.resolve(process.cwd(), '.env');
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const parsed = dotenv.parse(raw);
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (_err) {
    // .env is optional; environment variables remain the source of truth.
  }
}

function asInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveConfig() {
  loadDotFile();

  const nodeEnv = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  const errors = [];

  const jwtSecret = process.env.JWT_SECRET || '';
  if (nodeEnv === 'production' && (!jwtSecret || jwtSecret.length < 32)) {
    errors.push('JWT_SECRET must be set and at least 32 characters in production');
  }

  // Metadata store migration: the control plane (users, databases, API keys,
  // audit) lives in MongoDB now, so every boot needs the metadata store wired.
  const mongoUri = (process.env.MONGODB_URI || '').trim();
  if (!mongoUri) {
    errors.push('MONGODB_URI is required: the platform stores users, databases, API keys and audit trails in MongoDB');
  }

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
      level: 'fatal',
      event: 'config_validation_failed',
      errors,
      ts: new Date().toISOString(),
    }));
    process.exit(1);
  }

  // Cross-origin browser clients (the separate Next.js frontend). Exact-match
  // origin allowlist; same-origin consumers (tests, curl, agents) are never
  // restricted. The deployed frontend origin is ALWAYS allowed so a fresh
  // deployment answers browser preflight before any panel env is configured;
  // CORS_ORIGINS extends the list with custom domains (duplicates ignored).
  const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
  const FRONTEND_ORIGINS = [ // deployed Next.js frontend: exact task origin + the live project alias
    'https://frontend-nine-rosy-15fjh5o7tt.vercel.app',
    'https://cacheify-redis-host.vercel.app',
  ];
  const isDevelopment = nodeEnv !== 'production';
  const hasDevOrigins = isDevelopment ? ['http://localhost:3001', 'http://127.0.0.1:3001'] : [];
  const effectiveCorsOrigins = Object.freeze([...new Set([...corsOrigins, ...FRONTEND_ORIGINS, ...hasDevOrigins])]);

  const config = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    // Binding: the Botkeep/Pterodactyl-style proxy reaches the app through the
    // container's external interface, so the default is 0.0.0.0 — a loopback
    // bind is invisible to the proxy and every upstream request 503s with
    // "application is not responding". HOST=127.0.0.1 stays an explicit
    // local-only choice for loopback development.
    host: (process.env.HOST || '').trim() || '0.0.0.0',
    // Port: PORT first, then the panel-assigned SERVER_PORT injected by
    // Pterodactyl-style eggs, then the 3000 fallback. Empty strings fall
    // through to the next source, so PORT= does not shadow SERVER_PORT.
    port: asInt(process.env.PORT || process.env.SERVER_PORT, 3000),
    corsOrigins: effectiveCorsOrigins,
    jwtSecret:
      jwtSecret || crypto.randomUUID().repeat(2), // ephemeral dev fallback, never persisted
    jwtTtlMs: asInt(process.env.JWT_TTL_MINUTES, 720) * 60 * 1000,
    adminEmail: process.env.ADMIN_EMAIL || '',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    defaultUserQuota: {
      maxDatabases: asInt(process.env.QUOTA_MAX_DATABASES, 5),
      maxKeysPerDb: asInt(process.env.QUOTA_MAX_KEYS_PER_DB, 10000),
      maxValueBytes: asInt(process.env.QUOTA_MAX_VALUE_BYTES, 512 * 1024),
    },
    rateLimit: {
      windowMs: asInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
      maxPublic: asInt(process.env.RATE_LIMIT_MAX_PUBLIC, 30),
      maxAuthenticated: asInt(process.env.RATE_LIMIT_MAX_AUTHENTICATED, 240),
    },
    // Remote data-plane quota-count caching: the per-namespace key count used
    // by the quota preflight is cached for this long (burst-safe: the cached
    // value is incremented per creating write, so plan limits are enforced
    // conservatively between recalculations).
    quotaCountTtlMs: asInt(process.env.QUOTA_COUNT_TTL_MS, 30_000),
    // Mandatory-expiry policy: writes that would leave a key without a TTL
    // receive this default expiry instead, so no key is ever immortal.
    defaultKeyTtlMs: asInt(process.env.DEFAULT_KEY_TTL_MS, 24 * 60 * 60 * 1000),
    // Optional integrations: email-OTP verification via Brevo and user profile
    // storage via MongoDB. Both are feature-gated: disabled (with a clear
    // error) until their credentials exist in the environment.
    integrations: {
      brevoApiKey: (process.env.BREVO_API_KEY || '').trim(),
      senderEmail: (process.env.BREVO_SENDER_EMAIL || '').trim(),
      senderName: (process.env.BREVO_SENDER_NAME || 'Cacheify').trim(),
      // SMTP relay transport (see .env.example MAIL_* block). Used when the
      // Brevo REST API key is absent; credentials stay in .env only.
      mailHost: (process.env.MAIL_HOST || '').trim(),
      mailPort: asInt(process.env.MAIL_PORT, 2525),
      mailUsername: (process.env.MAIL_USERNAME || '').trim(),
      mailPassword: (process.env.MAIL_PASSWORD || '').trim(),
      mailFrom: (process.env.MAIL_FROM || '').trim(),
      mongoUri: (process.env.MONGODB_URI || '').trim(),
      mongoDb: (process.env.MONGODB_DB || 'cacheify').trim(),
    },
    otp: {
      ttlMs: asInt(process.env.OTP_TTL_MS, 10 * 60_000),
      resendCooldownMs: asInt(process.env.OTP_RESEND_COOLDOWN_MS, 60_000),
      maxAttempts: asInt(process.env.OTP_MAX_ATTEMPTS, 5),
    },
    bodyLimitBytes: asInt(process.env.BODY_LIMIT_BYTES, 256 * 1024),
    // Per-database in-flight data-plane command cap. A saturated database
    // answers 429 + Retry-After immediately instead of holding sockets (the
    // queue-with-backpressure contract; no unbounded pipelined floods).
    maxInflightPerDb: asInt(process.env.MAX_INFLIGHT_PER_DB, 24),
    bcryptCost: asInt(process.env.BCRYPT_COST, 10),
    sweepIntervalMs: asInt(process.env.SWEEP_INTERVAL_MS, 60_000),
  };

  // Data-plane backend: a real Redis server (remote) or the platform's own
  // engine on the MongoDB key store. The connection string is optional; when
  // absent the local engine serves all data-plane traffic.
  const rawConnectionString = (process.env.REDIS_CONNECTION_STRING || '').trim();
  if (rawConnectionString) {
    // Accept scheme-less forms (host:port, host:port,password=...) by prefixing.
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawConnectionString)
      ? rawConnectionString
      : `redis://${rawConnectionString}`;
    config.redis = Object.freeze({
      mode: 'remote',
      connectionString: normalized,
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'rh:',
      // Optional CA bundle (PEM) to trust: required by providers that issue
      // their own certificate. Verification/hostname checks stay ON.
      tlsCaFile: (process.env.REDIS_TLS_CA_FILE || '').trim()
        ? path.resolve(process.env.REDIS_TLS_CA_FILE.trim())
        : '',
    });
  } else {
    config.redis = Object.freeze({
      mode: 'embedded',
      connectionString: '',
      keyPrefix: 'rh:',
      tlsCaFile: '',
    });
  }

  return Object.freeze(config);
}

const config = resolveConfig();

module.exports = { config };
