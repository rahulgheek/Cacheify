'use strict';

/**
 * Machine-readable contracts (OpenAPI 3.1 + llms.txt index for agents).
 * Derived from the route table; update when endpoints change.
 */

const SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'Redis Hosting Platform API',
    version: '1.0.0',
    description: 'Multi-user Redis hosting platform. All responses use the envelope ' +
      '{"success":true,"data":...,"meta":...} or {"success":false,"error":{"code","message","details?"}}. ' +
      'Authentication: Bearer session token (Authorization header) or API key token (rk_...).',
  },
  servers: [{ url: '/', description: 'API base' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' } },
    schemas: {
      ErrorEnvelope: {
        type: 'object',
        required: ['success', 'error'],
        properties: {
          success: { type: 'boolean', const: false },
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', examples: ['ERR_VALIDATION', 'ERR_NOT_FOUND', 'ERR_QUOTA_EXCEEDED'] },
              message: { type: 'string' },
              details: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { field: { type: 'string' }, issue: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
  paths: {
    '/api/auth/register': {
      post: {
        summary: 'Create an account and receive a session token',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8, maxLength: 128 } }, additionalProperties: false } } },
        },
        responses: { '200': { description: 'Session created' }, '409': { description: 'Email already registered' } },
      },
    },
    '/api/auth/login': {
      post: {
        summary: 'Log in and receive a session token',
        security: [],
        responses: { '200': { description: 'Session created' }, '401': { description: 'Invalid credentials' } },
      },
    },
    '/api/auth/me': { get: { summary: 'Current session user and quota (emailVerified included)', responses: { '200': { description: 'OK' } } } },
    '/api/auth/whoami': {
      get: {
        summary: 'Caller identity: session user, or an rk_ key with its database scope',
        description: 'API-key callers receive kind=apiKey plus databaseId (the key\'s own database; null for legacy unscoped keys) and permission. Used by the RESP gateway to route each AUTH\'d connection.',
        responses: { '200': { description: 'OK' }, '401': { description: 'Unknown or revoked token' } },
      },
    },
    '/api/auth/otp/request': {
      post: {
        summary: 'Send the email-verification code (Brevo OTP) to the signed-in account',
        description: 'Resend cooldown applies (default 60s). Without an email provider configured the response carries devCodeOverride (mock mode); with a provider the code is never echoed.',
        responses: { '200': { description: 'Code sent (or surfaced locally in mock mode)' }, '429': { description: 'Resend cooldown active' } },
      },
    },
    '/api/auth/otp/verify': {
      post: {
        summary: 'Verify the 6-digit code; unlocks the control and data plane',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: '^[0-9]{6}$' } }, additionalProperties: false } } },
        },
        responses: { '200': { description: 'Email verified' }, '422': { description: 'Wrong or expired code' }, '429': { description: 'Too many attempts; request a new code' } },
      },
    },
    '/api/profile': {
      get: { summary: 'The signed-in user\'s saved profile data (defaults until first save; requires MONGODB_URI writes)', responses: { '200': { description: 'OK' } } },
      put: {
        summary: 'Save profile data (displayName, bio, avatarColor) in the platform NoSQL store (MongoDB)',
        description: '503 when MONGODB_URI is not configured.',
        responses: { '200': { description: 'Saved' }, '503': { description: 'MongoDB not configured' } },
      },
    },
    '/api/databases': {
      get: { summary: 'List databases (admins see all tenants)', responses: { '200': { description: 'OK' } } },
      post: { summary: 'Create a database (quota: maxDatabases)', responses: { '201': { description: 'Created' }, '403': { description: 'Quota exceeded' } } },
    },
    '/api/databases/{dbId}': {
      get: { summary: 'Database detail with key stats', responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
      patch: { summary: 'Rename, edit description, or set status (active/archived)', responses: { '200': { description: 'OK' } } },
      delete: { summary: 'Delete database, all keys and its scoped API keys (destructive)', responses: { '200': { description: 'Deleted' } } },
    },
    '/api/databases/{dbId}/flush': {
      post: { summary: 'Wipe every key in this database, keeping the database and its API keys (destructive)', responses: { '200': { description: 'Flushed' }, '403': { description: 'API key is read-only' } } },
    },
    '/api/api-keys': {
      get: { summary: 'List API keys (prefixes only; each carries its database scope and permission)', responses: { '200': { description: 'OK' } } },
      post: {
        summary: 'Create an API key scoped to one database with a permission level; plaintext is returned once',
        description: 'Exactly one ACTIVE key per database: a second creation for the same database fails with 409 ERR_CONFLICT until the existing key is revoked. Rotation = revoke, then mint.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['name', 'databaseId'], properties: { name: { type: 'string' }, databaseId: { type: 'string' }, permission: { type: 'string', enum: ['read-only', 'read-write'], default: 'read-write' } }, additionalProperties: false } } },
        },
        responses: { '201': { description: 'Created' }, '404': { description: 'Unknown database' }, '409': { description: 'Database already has an active key' } },
      },
    },
    '/api/api-keys/{keyId}': {
      delete: { summary: 'Revoke an API key (idempotent)', responses: { '200': { description: 'OK' } } },
    },
    '/api/databases/{dbId}/api-keys': {
      post: {
        summary: 'Create the database-scoped API key from the database context (databaseId comes from the path)',
        description: 'Same rule as /api/api-keys: exactly one active key per database; 409 ERR_CONFLICT while one exists.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, permission: { type: 'string', enum: ['read-only', 'read-write'], default: 'read-write' } }, additionalProperties: false } } },
        },
        responses: { '201': { description: 'Created (data.plaintext shown once)' }, '404': { description: 'Unknown database' }, '409': { description: 'Database already has an active key' } },
      },
    },
    '/api/databases/{dbId}/api-key': {
      get: {
        summary: 'The current active API key for this database (prefix only), or null when none exists',
        responses: { '200': { description: 'OK (data.apiKey is null when no active key)' }, '404': { description: 'Unknown database' } },
      },
    },
    '/api/data/{dbId}/command': {
      post: {
        summary: 'Execute one Redis-compatible command',
        description: 'Supported commands: ' + [
          'GET SET SETEX PSETEX MGET MSET INCR DECR INCRBY DECRBY APPEND STRLEN GETRANGE',
          'EXISTS DEL TYPE KEYS SCAN EXPIRE PEXPIRE TTL PTTL EXPIRETIME RENAME FLUSHDB',
          'LPUSH RPUSH LPOP RPOP LRANGE LLEN LINDEX LSET LTRIM LREM',
          'SADD SREM SISMEMBER SMEMBERS SCARD SINTER SUNION SDIFF',
          'HSET HGET HGETALL HDEL HKEYS HVALS HLEN HEXISTS',
          'ZADD ZSCORE ZCARD ZREM ZRANGE',
        ].join(' ') +
          '. Mandatory-expiry policy: SET/SETEX/PSETEX/MSET without an explicit TTL, ' +
          'and any creating write (INCR, APPEND, LPUSH, RPUSH, SADD, HSET, ZADD), receive a ' +
          'default 24h TTL so no key is ever immortal; PERSIST is rejected with 422.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['command'], properties: { command: { type: 'string', examples: ['SET', 'GET', 'HSET'] }, args: { type: 'array', items: { type: ['string', 'number'] }, maxItems: 256 } }, additionalProperties: false } } },
        },
        responses: { '200': { description: 'Result value (Redis nil = null)' }, '403': { description: 'Read-only API key used for a mutating command' }, '422': { description: 'Unknown command, bad args, or PERSIST (disabled by the mandatory-expiry policy)' } },
      },
    },
    '/api/data/{dbId}/pipeline': {
      post: { summary: 'Execute 1-50 commands atomically', responses: { '200': { description: 'Results array' } } },
    },
    '/api/data/{dbId}/keys': {
      get: {
        summary: 'Browse keys (cursor pagination + glob pattern)',
        parameters: [
          { name: 'pattern', in: 'query', schema: { type: 'string' } },
          { name: 'cursor', in: 'query', schema: { type: 'integer', minimum: 0 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        ],
        responses: { '200': { description: 'Page of keys' } },
      },
    },
    '/api/data/{dbId}/keys/{key}': {
      get: { summary: 'Key detail with typed value and TTL', responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
      delete: { summary: 'Delete a key', responses: { '200': { description: 'OK' } } },
    },
    '/api/data/{dbId}/keys/{key}/expire': {
      post: { summary: 'Set TTL (ms)', responses: { '200': { description: 'OK' } } },
      delete: {
        summary: 'Remove TTL (persist)',
        description: 'Disabled by the mandatory-expiry policy: every key must keep an expiry. Responds 422.',
        responses: { '422': { description: 'PERSIST is disabled' } },
      },
    },
    '/api/data/{dbId}/strings/{key}': {
      put: {
        summary: 'Set a string value (optional expiresInMs)',
        description: 'Without expiresInMs the platform-appended default TTL (24h) applies.',
        responses: { '201': { description: 'Created' } },
      },
    },
    '/api/users': {
      get: { summary: 'List users (admin), cursor pagination + q search', responses: { '200': { description: 'OK' } } },
    },
    '/api/users/{userId}': {
      get: { summary: 'User detail with usage stats (admin)', responses: { '200': { description: 'OK' } } },
      patch: {
        summary: 'Update status, role or quotas (admin); sessions rotate on role/status change',
        responses: { '200': { description: 'OK' }, '409': { description: 'Self-suspension rejected' } },
      },
    },
  },
};

function spec() {
  return SPEC;
}

function llmsTxt() {
  return [
    '# Redis Hosting Platform',
    '',
    'A multi-tenant, Redis-compatible data platform exposed over HTTP.',
    '',
    '## How to use',
    '- Register: POST /api/auth/register {"email":"...","password":"..."} (new accounts start UNVERIFIED).',
    '- Verify email: POST /api/auth/otp/request (sends the 6-digit code), then POST /api/auth/otp/verify {"code":"123456"}. Databases, API keys and the data plane stay locked (403) until verification passes.',
    '- Create a database: POST /api/databases {"name":"my-db"}',
    '- Run commands: POST /api/data/{dbId}/command {"command":"SET","args":["greeting","hello"]}',
    '- Read back: {"command":"GET","args":["greeting"]}',
    '- Browse keys: GET /api/data/{dbId}/keys?pattern=user:*&cursor=0&limit=25',
    '',
    '## Conventions',
    '- Every response uses {"success":true,"data":...} or {"success":false,"error":{...}}.',
    '- Redis nil is represented as null; COUNT-like replies are integers.',
    '- Status codes never leak existence of other tenants resources (404 is used).',
    '- Mandatory-expiry policy: every key always has a TTL. Writes without an explicit expiry receive the platform default TTL (24 hours); PERSIST is rejected with 422. Re-arm life with EXPIRE or set expiresInMs.',
    '',
    '## API keys',
    '- Exactly one active API key per database. Create: POST /api/databases/{dbId}/api-keys {"name":"my-app","permission":"read-write"}.',
    '- The plaintext (rk_...) is returned once at creation; store it, never log it.',
    '- To change the key: DELETE /api/api-keys/{keyId} (revoke) first, then create a new one.',
    '- GET /api/databases/{dbId}/api-key returns the active key metadata (prefix only) or null.',
    '',
    '## Agent endpoints index',
    '- OpenAPI 3.1 document: GET /api/openapi.json',
    '- Email-verification OTP: POST /api/auth/otp/request + POST /api/auth/otp/verify {"code":"123456"}.',
    '- User profile (MongoDB-backed): GET /api/profile, PUT /api/profile {"displayName","bio","avatarColor"}.',
  ].join('\n');
}

module.exports = { spec, llmsTxt };
