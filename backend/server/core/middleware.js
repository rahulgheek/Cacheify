'use strict';

/**
 * Central HTTP middleware (core).
 * Pipeline per endpoint: request context -> authenticate -> validate -> authorize -> handle.
 */

const util = require('node:util');
const { config } = require('./env');
const { verifyToken, hashApiKey } = require('./crypto');
const store = require('./store');
const logger = require('./logger');
const errors = require('./errors');
const phaseTimer = require('./phase-timer');

/* ----------------------------- Request context ---------------------------- */

function requestContext(req, res, next) {
  req.requestId = crypto.randomUUID();
  req.log = {
    info: (event, context = {}) => logger.info(event, { requestId: req.requestId, ...context }),
    warn: (event, context = {}) => logger.warn(event, { requestId: req.requestId, ...context }),
    error: (event, context = {}) => logger.error(event, { requestId: req.requestId, ...context }),
  };
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

/* ------------------------------- Rate limiting ---------------------------- */

const rateBuckets = new Map(); // key -> { windowStart, count, timer }

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.windowStart > config.rateLimit.windowMs * 2) rateBuckets.delete(key);
  }
}, config.rateLimit.windowMs).unref();

function rateLimit({ max, keyPrefix = 'global' } = {}) {
  return (req, res, next) => {
    const windowMs = config.rateLimit.windowMs;
    const now = Date.now();
    const identity = req.user ? `u${req.user.id}` : (req.ip || 'anonymous');
    const key = `${keyPrefix}:${identity}`;
    const limit = max ?? (req.user ? config.rateLimit.maxAuthenticated : config.rateLimit.maxPublic);

    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      if (bucket && bucket.timer) clearTimeout(bucket.timer);
      bucket = {
        windowStart: now,
        count: 0,
        timer: setTimeout(() => rateBuckets.delete(key), windowMs * 2),
      };
      bucket.timer.unref();
      rateBuckets.set(key, bucket);
    }

    bucket.count += 1;
    const retryAfterSec = Math.ceil((bucket.windowStart + windowMs - now) / 1000);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));

    if (bucket.count > limit) {
      res.setHeader('Retry-After', String(retryAfterSec));
      return next(new errors.RateLimitError());
    }
    return next();
  };
}

/* --------------------------------- Auth ----------------------------------- */

async function userFromSession(token) {
  const payload = verifyToken(token);
  if (!payload || payload.kind !== 'session') return null;
  const users = await store.getUsers();
  const user = await users.findOne({ _id: Number(payload.sub) });
  if (!user || user.status !== 'active') return null;
  if (user.token_version !== (payload.tv || 0)) return null;
  const row = store.rowize(user);
  delete row.password_hash; // session principals never carry credentials
  return { kind: 'session', apiKeyId: null, user: row };
}

async function userFromApiKey(token) {
  if (!token.startsWith('rk_')) return null;
  const apiKeys = await store.getApiKeys();
  const databases = await store.getDatabases();
  const keyDoc = await apiKeys.findOne({ key_hash: hashApiKey(token) });
  if (!keyDoc || keyDoc.revoked_at) return null;
  const scopeDoc = keyDoc.database_id
    ? await databases.findOne({ _id: keyDoc.database_id }) : null;
  const users = await store.getUsers();
  const userDoc = await users.findOne({ _id: keyDoc.user_id });
  if (!userDoc || userDoc.status !== 'active') return null;
  // Fire-and-forget last-used stamp (audit-grade telemetry, non-critical).
  apiKeys.updateOne({ _id: keyDoc._id }, { $set: { last_used_at: new Date().toISOString() } })
    .catch(() => {});
  return {
    kind: 'apiKey',
    apiKeyId: keyDoc._id,
    user: {
      id: userDoc._id,
      public_id: userDoc.public_id,
      email: userDoc.email,
      role: userDoc.role,
      status: userDoc.status,
      email_verified: userDoc.email_verified,
      max_databases: userDoc.max_databases,
      max_keys_per_db: userDoc.max_keys_per_db,
      max_value_bytes: userDoc.max_value_bytes,
      token_version: undefined,
      // Scope envelope: null database = legacy unscoped key (full account
      // access, read-write); otherwise every data-plane request is limited
      // to this database and the key's permission level.
      apiKeyScope: {
        databasePublicId: scopeDoc ? scopeDoc.public_id : null,
        permission: keyDoc.permission || 'read-write',
      },
    },
  };
}

async function attachUser(req, _res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  const token = header.slice(7).trim();
  try {
    const auth = (await userFromSession(token)) || (await userFromApiKey(token));
    if (auth) {
      req.user = auth.user;
      req.authKind = auth.kind;
      req.apiKeyId = auth.apiKeyId;
    }
  } catch (err) {
    req.log?.warn('auth_lookup_failed', { error: err.message });
  }
  return next();
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(new errors.UnauthorizedError());
  return next();
}

function requireAdmin(req, _res, next) {
  if (!req.user) return next(new errors.UnauthorizedError());
  if (req.user.role !== 'admin') return next(new errors.ForbiddenError('Admin role required'));
  return next();
}

/** Verification gate: accounts created after the email-OTP rollout must
    verify their address before using the control/data plane. Accounts that
    predate the feature (and admins) are grandfathered (email_verified = 1). */
function requireVerifiedEmail(req, _res, next) {
  if (!req.user) return next(new errors.UnauthorizedError());
  if (req.user.role === 'admin') return next();
  if (req.user.email_verified === 0) {
    return next(new errors.ForbiddenError(
      'Email not verified: check your inbox for the code or request a new one (POST /api/auth/otp/request)',
    ));
  }
  return next();
}

/* ------------------------------ Validation -------------------------------- */

function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const raw = source === 'headers' ? req.headers : req[source];
    const result = schema.safeParse(raw);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || source,
        issue: issue.message,
      }));
      return next(new errors.ValidationError('Request validation failed', details));
    }
    // Express 5 exposes req.query via a fresh getter; validated values live on req.validated.
    if (!req.validated) req.validated = {};
    req.validated[source] = result.data;
    if (source === 'body') req.body = result.data; // req.body is a plain writable property
    return next();
  };
}

/* ------------------------------ Error boundary ---------------------------- */

function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: { code: 'ERR_NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  // Engine domain errors (Redis semantics like WRONGTYPE) are 422 with ERR_REDIS.
  if (err && err.name === 'EngineError') {
    return res.status(422).json({
      success: false,
      error: { code: err.code || 'ERR_REDIS', message: err.message },
    });
  }

  const isUniqueViolation = err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (err.code === 'SQLITE_CONSTRAINT' && /UNIQUE constraint failed/.test(err.message || '')));
  if (isUniqueViolation) {
    const conflict = new (require('./errors').ConflictError)('A resource with the same unique value already exists');
    return res.status(409).json({
      success: false,
      error: { code: conflict.code, message: conflict.message },
    });
  }

  const status = typeof err.status === 'number' && err.status >= 400 ? err.status : 500;
  const code = err.code || (status === 500 ? 'ERR_INTERNAL' : 'ERR_REQUEST');
  const isDomain = err instanceof errors.AppError;

  if (status === 500) {
    req.log?.error('unhandled_error', {
      error: isDomain ? err.message : `${err.name || 'Error'}: ${err.message}`,
      stack: config.isProduction ? undefined : err.stack ? util.inspect(err.stack) : undefined,
      path: req.path,
    });
  }

  const safeMessage = isDomain || status !== 500 ? err.message || 'Request failed' : 'Internal server error';
  const payload = {
    success: false,
    error: {
      code,
      message: safeMessage,
      ...(err.details && Array.isArray(err.details) ? { details: err.details } : {}),
    },
  };
  if (res.headersSent) return;
  phaseTimer.setHeader(res); // error envelopes carry the same observability
  res.status(status).json(payload);
}

module.exports = {
  requestContext,
  rateLimit,
  attachUser,
  requireAuth,
  requireAdmin,
  requireVerifiedEmail,
  validate,
  notFoundHandler,
  errorHandler,
};
