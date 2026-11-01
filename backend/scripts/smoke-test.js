#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test: boots the app on an ephemeral port with an isolated
 * data directory and exercises the full user flow across every module.
 */

// This suite exercises the LOCAL engine (platform's own; MongoDB key store);
// it must never follow .env into remote mode (empty values count as "present"
// for the .env loader).
process.env.NODE_ENV = 'development';
process.env.REDIS_CONNECTION_STRING = '';
process.env.REDIS_TLS_CA_FILE = '';
// Mailer must stay in MOCK mode for tests: the .env loader never overrides
// existing process.env keys, so empty strings here block .env MAIL_* leakage
// (otherwise the harness would send real SMTP mails to @test.dev addresses).
process.env.BREVO_API_KEY = '';
process.env.MAIL_HOST = '';
// Metadata migration: the control plane IS the Mongo store now. Keep MONGODB_URI
// from .env but pin the run to an isolated per-run Atlas database so smoke and
// production data never mix. The test database is dropped at the end of main().
process.env.MONGODB_DB = `cacheify-smoke-${Math.floor(Math.random() * 1e10)}`;
process.env.ADMIN_EMAIL = 'admin@example.test';
process.env.ADMIN_PASSWORD = 'admin-password-1234';
process.env.SWEEP_INTERVAL_MS = '30000';

const assert = require('node:assert');
const { buildApp } = require('../server/app');

const BASE = `http://127.0.0.1`;

let client;
let port;

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function step(name, fn) {
  await fn();
  console.log(`ok - ${name}`);
}

/** Complete email verification for a token (mock mode: codes surface locally). */
async function verifyEmail(token) {
  const req = await call('POST', '/api/auth/otp/request', { token });
  assert.equal(req.status, 200);
  const code = req.json.data.devCodeOverride;
  assert.ok(typeof code === 'string' && /^\d{6}$/.test(code), 'mock mode must surface devCodeOverride');
  // Mock mode guarantees no cooldown race is flaky here: the resend cooldown is
  // per-account, so a fresh verifyEmail on a NEW account is unaffected.
  const ver = await call('POST', '/api/auth/otp/verify', { token, body: { code } });
  assert.equal(ver.status, 200);
  return ver;
}

async function main() {
  await require('../server/core/bootstrap').seedAdmin();
  const server = buildApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;

  try {
    let userToken;
    let adminToken;
    let dbId;
    let pendingVerificationCode = null;

    await step('health: static routes wired', async () => {
      const res = await fetch(`${BASE}:${port}/llms.txt`);
      assert.equal(res.status, 200);
    });

    await step('health: API-only (no static hosting)', async () => {
      // Frontend moved to ../frontend (Next.js): documentGETs must not be
      // served from this process, not even the legacy SPA fallback.
      const res = await fetch(`${BASE}:${port}/`, { headers: { accept: 'text/html' } });
      assert.equal(res.status, 404);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.error.code, 'ERR_NOT_FOUND');
      const spa = await fetch(`${BASE}:${port}/databases`);
      assert.equal(spa.status, 404);
    });

    await step('cors: preflight (OPTIONS) with allowed origin echoed exactly', async () => {
      const res = await fetch(`${BASE}:${port}/api/auth/login`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:3001',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,authorization',
        },
      });
      assert.equal(res.status, 204, 'allowed preflight is 204');
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3001', 'exact origin echo');
      const methods = (res.headers.get('access-control-allow-methods') || '').split(',').map((m) => m.trim().toUpperCase());
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        assert.ok(methods.includes(method), `allow-methods must include ${method}`);
      }
      const allowHeaders = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
      assert.ok(allowHeaders.includes('authorization') && allowHeaders.includes('content-type'),
        'preflight must permit authorization + content-type');
    });

    await step('cors: preflight with disallowed origin carries no ACAO header', async () => {
      const res = await fetch(`${BASE}:${port}/api/auth/login`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example.net',
          'access-control-request-method': 'POST',
        },
      });
      assert.equal(res.headers.get('access-control-allow-origin'), null, 'unknown origins get no ACAO');
    });

    await step('cors: actual login from allowed origin is CORS-stamped', async () => {
      // No real credentials: unknown account -> 401 envelope, still CORS-stamped.
      const res = await fetch(`${BASE}:${port}/api/auth/login`, {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3001',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'ghost@test.dev', password: 'wrong-password' }),
      });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3001',
        'ACAO present on the actual response, exact origin');
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.error.code, 'ERR_UNAUTHORIZED');
    });

    await step('auth: register validation rejects short password', async () => {
      const { status, json } = await call('POST', '/api/auth/register', {
        body: { email: 'bad@test.dev', password: 'short' },
      });
      assert.equal(status, 422);
      assert.equal(json.success, false);
      assert.ok(json.error.details.length > 0);
    });

    await step('auth: register success', async () => {
      const { status, json } = await call('POST', '/api/auth/register', {
        body: { email: 'owner@test.dev', password: 'super-secret-9' },
      });
      assert.equal(status, 200);
      assert.equal(json.success, true);
      assert.ok(json.data.token.startsWith('eyJ'));
      assert.equal(json.data.user.email, 'owner@test.dev');
      assert.equal(json.data.user.quota.maxDatabases, 5);
      assert.ok(!('password_hash' in json.data.user));
      assert.equal(json.data.verificationRequired, true, 'new accounts start unverified');
      assert.equal(json.data.user.emailVerified, false);
      userToken = json.data.token;
    });

    await step('verification: control plane is gated until email verify', async () => {
      const create = await call('POST', '/api/databases', {
        token: userToken,
        body: { name: 'prod-cache' },
      });
      assert.equal(create.status, 403);
      assert.equal(create.json.error.code, 'ERR_FORBIDDEN');

      const list = await call('GET', '/api/databases', { token: userToken });
      assert.equal(list.status, 403);
    });

    await step('verification: otp request cooldown + wrong code rejected', async () => {
      const first = await call('POST', '/api/auth/otp/request', { token: userToken });
      assert.equal(first.status, 200);
      assert.ok(/^\d{6}$/.test(first.json.data.devCodeOverride));
      pendingVerificationCode = first.json.data.devCodeOverride;

      const spam = await call('POST', '/api/auth/otp/request', { token: userToken });
      assert.equal(spam.status, 429, 'resend cooldown active');

      const wrong = await call('POST', '/api/auth/otp/verify', { token: userToken, body: { code: '000000' } });
      assert.equal(wrong.status, 422);
      assert.equal(wrong.json.error.code, 'ERR_VALIDATION');
    });

    await step('verification: correct code unlocks the platform', async () => {
      // The single in-flight code from the request step is still valid
      // (cooldown blocks new sends for 60s, not verification).
      const ver = await call('POST', '/api/auth/otp/verify', {
        token: userToken,
        body: { code: pendingVerificationCode },
      });
      assert.equal(ver.status, 200);
      assert.equal(ver.json.data.verified, true);

      const me = await call('GET', '/api/auth/me', { token: userToken });
      assert.equal(me.json.data.user.emailVerified, true);

      const create = await call('POST', '/api/databases', {
        token: userToken,
        body: { name: 'gate-probe' },
      });
      assert.equal(create.status, 201);
      const del = await call('DELETE', `/api/databases/${create.json.data.database.id}`, { token: userToken });
      assert.equal(del.status, 200);
    });

    await step('auth: duplicate email conflicts', async () => {
      const { status } = await call('POST', '/api/auth/register', {
        body: { email: 'OWNER@test.dev', password: 'super-secret-9' },
      });
      assert.equal(status, 409);
    });

    await step('auth: login works', async () => {
      const { status, json } = await call('POST', '/api/auth/login', {
        body: { email: 'owner@test.dev', password: 'super-secret-9' },
      });
      assert.equal(status, 200);
      userToken = json.data.token;
    });

    await step('auth: bad password is 401 with envelope', async () => {
      const { status, json } = await call('POST', '/api/auth/login', {
        body: { email: 'owner@test.dev', password: 'wrong-password' },
      });
      assert.equal(status, 401);
      assert.equal(json.error.code, 'ERR_UNAUTHORIZED');
    });

    await step('auth: /me requires session', async () => {
      const { status } = await call('GET', '/api/auth/me');
      assert.equal(status, 401);
      const { status: okStatus, json } = await call('GET', '/api/auth/me', { token: userToken });
      assert.equal(okStatus, 200);
      assert.equal(json.data.user.email, 'owner@test.dev');
    });

    await step('auth: bootstrap admin can log in', async () => {
      const { status, json } = await call('POST', '/api/auth/login', {
        body: { email: 'admin@example.test', password: 'admin-password-1234' },
      });
      assert.equal(status, 200);
      adminToken = json.data.token;
      assert.equal(json.data.user.role, 'admin');
    });

    await step('databases: create, duplicate, and list', async () => {
      const { status, json } = await call('POST', '/api/databases', {
        token: userToken,
        body: { name: 'prod-cache', description: 'session cache' },
      });
      assert.equal(status, 201);
      dbId = json.data.database.id;
      assert.ok(dbId.startsWith('rdb_'));

      const dup = await call('POST', '/api/databases', { token: userToken, body: { name: 'prod-cache' } });
      assert.equal(dup.status, 409);

      const list = await call('GET', '/api/databases', { token: userToken });
      assert.equal(list.json.data.databases.length, 1);
    });

    await step('profile: mongo defaults then save persists to Atlas test db', async () => {
      const got = await call('GET', '/api/profile', { token: userToken });
      assert.equal(got.status, 200);
      assert.equal(got.json.data.profile.displayName, '');
      assert.equal(got.json.data.profile.avatarColor, '#ef4444');

      const saved = await call('PUT', '/api/profile', {
        token: userToken,
        body: { displayName: 'Smoke Runner', bio: 'e2e', avatarColor: '#0ea5e9' },
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.data.profile.displayName, 'Smoke Runner');

      const invalid = await call('PUT', '/api/profile', {
        token: userToken,
        body: { displayName: 'x', bio: 'ok', avatarColor: 'red' },
      });
      assert.equal(invalid.status, 422);
    });

    await step('cross-tenant: another user cannot see the database', async () => {
      const reg = await call('POST', '/api/auth/register', {
        body: { email: 'intruder@test.dev', password: 'super-secret-9' },
      });
      assert.equal(reg.json.data.verificationRequired, true);
      const { json } = await call('POST', '/api/auth/login', {
        body: { email: 'intruder@test.dev', password: 'super-secret-9' },
      });
      // The gate blocks unverified tenants before tenancy rules, which is
      // tested above; verify to exercise the 404 cross-tenant isolation itself.
      await verifyEmail(json.data.token);
      const { status: stillListed } = await call('GET', '/api/databases', { token: json.data.token });
      assert.equal(stillListed, 200);
      const { status: crossGet } = await call('GET', `/api/databases/${dbId}`, { token: json.data.token });
      assert.equal(crossGet, 404);
    });

    await step('data: strings (SET/GET/INCR/APPEND)', async () => {
      let { json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'SET', args: ['session:alpha', 'hello world'] },
      });
      assert.equal(json.data.result, 'OK');

      ({ json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'GET', args: ['session:alpha'] },
      }));
      assert.equal(json.data.result, 'hello world');

      ({ json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'INCR', args: ['counter'] },
      }));
      assert.equal(json.data.result, 1);

      ({ json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'APPEND', args: ['session:alpha', ' plus'] },
      }));
      assert.equal(json.data.result, Buffer.byteLength('hello world plus'));
    });

    await step('data: set semantics NX returns null on existing', async () => {
      const { json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'SET', args: ['session:alpha', 'nope', 'NX'] },
      });
      assert.equal(json.data.result, null);
    });

    await step('data: TTL set and reported correctly', async () => {
      let { json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'PEXPIRE', args: ['counter', 60000] },
      });
      assert.equal(json.data.result, 1);

      ({ json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'TTL', args: ['counter'] },
      }));
      assert.ok(json.data.result > 55 && json.data.result <= 60);

      // Mandatory-expiry policy: PERSIST is rejected and the TTL stays armed.
      let persistStatus = 0;
      ({ status: persistStatus } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'PERSIST', args: ['counter'] },
      }));
      assert.equal(persistStatus, 422);

      ({ json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'TTL', args: ['counter'] },
      }));
      assert.ok(json.data.result > 50);
    });

    await step('policy: default TTL applied to no-expiry writes', async () => {
      let { json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'SET', args: ['defaultttl:string', 'x'] },
      });
      assert.equal(json.data.result, 'OK');
      ({ json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'PTTL', args: ['defaultttl:string'] },
      }));
      const defaultTtl = 24 * 60 * 60 * 1000;
      assert.ok(json.data.result > defaultTtl - 10_000 && json.data.result <= defaultTtl);

      ({ json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'INCR', args: ['defaultttl:counter'] },
      }));
      assert.equal(json.data.result, 1);
      ({ json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'PTTL', args: ['defaultttl:counter'] },
      }));
      assert.ok(json.data.result > defaultTtl - 10_000 && json.data.result <= defaultTtl);

      ({ json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'LPUSH', args: ['defaultttl:list', 'a'] },
      }));
      assert.equal(json.data.result, 1);
      ({ json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'PTTL', args: ['defaultttl:list'] },
      }));
      assert.ok(json.data.result > defaultTtl - 10_000 && json.data.result <= defaultTtl);

      // Explicit TTLs pass through untouched.
      ({ json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'SET', args: ['defaultttl:short', 'x', 'PX', 5000] },
      }));
      ({ json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'PTTL', args: ['defaultttl:short'] },
      }));
      assert.ok(json.data.result > 0 && json.data.result <= 5000);
    });

    await step('data: lists, sets, hashes, zsets', async () => {
      const execute = async (command, args) => (await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command, args },
      })).json.data.result;

      assert.equal(await execute('RPUSH', ['queue', 'a', 'b', 'c']), 3);
      assert.deepEqual(await execute('LRANGE', ['queue', '0', '-1']), ['a', 'b', 'c']);
      assert.equal(await execute('LPOP', ['queue']), 'a');

      assert.equal(await execute('SADD', ['tags', 'x', 'y', 'x']), 2);
      assert.equal(await execute('SISMEMBER', ['tags', 'y']), 1);
      assert.deepEqual(await execute('SMEMBERS', ['tags']), ['x', 'y']);

      assert.equal(await execute('HSET', ['user:1', 'email', 'a@b.c', 'name', 'Ada']), 2);
      assert.equal(await execute('HGET', ['user:1', 'name']), 'Ada');
      assert.equal(await execute('HGETALL', ['user:1']).then((o) => o.name), 'Ada');

      assert.equal(await execute('ZADD', ['board', '10', 'ada', '5', 'bob']), 2);
      assert.deepEqual(await execute('ZRANGE', ['board', '0', '-1', 'WITHSCORES']), ['bob', '5', 'ada', '10']);
    });

    await step('data: WRONGTYPE is a domain error', async () => {
      const { status, json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'LPUSH', args: ['tags', 'oops'] },
      });
      assert.equal(status, 422);
      assert.match(json.error.message, /WRONGTYPE|not an integer|wrong/);
      void json;
    });

    await step('data: unknown command is 422', async () => {
      const { status, json } = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken,
        body: { command: 'SUBSCRIBE', args: [] },
      });
      assert.equal(status, 422);
      assert.equal(json.error.code, 'ERR_REDIS');
    });

    await step('data: key browsing via REST with cursor', async () => {
      const { json } = await call('GET', `/api/data/${dbId}/keys?limit=2`, { token: userToken });
      assert.equal(json.success, true);
      assert.ok(json.data.keys.length > 0);
      assert.ok(json.data.keys[0].name);
    });

    await step('data: pipeline executes atomically', async () => {
      const { json } = await call('POST', `/api/data/${dbId}/pipeline`, {
        token: userToken,
        body: {
          commands: [
            { command: 'SET', args: ['p1', 'v1'] },
            { command: 'INCR', args: ['pcounter'] },
          ],
        },
      });
      assert.equal(json.data.results.length, 2);
      assert.equal(json.data.results[0].result, 'OK');
      assert.equal(json.data.results[1].result, 1);
    });

    await step('observability: Server-Timing rides every data envelope', async () => {
      const res = await fetch(`${BASE}:${port}/api/data/${dbId}/keys/pcounter`, {
        headers: { authorization: `Bearer ${userToken}` },
      });
      assert.equal(res.status, 200);
      const timing = res.headers.get('server-timing') || '';
      assert.ok(/^total;dur=[\d.]+/.test(timing), `Server-Timing must open with total (got: ${timing})`);
      // Phase attribution follows the active engine: embedded suite runs the
      // MongoDB key store (engine;dur=...); remote mode attributes redis;dur=...
      assert.ok(/(redis|engine);dur=[\d.]+/.test(timing), `phase attribution present (got: ${timing})`);
      assert.ok(res.headers.get('x-request-id'), 'X-Request-Id present');
    });

    await step('rate-limit: compound rules arm windows and report counters', async () => {
      const key = 'rl:otp:44';
      const first = await call('POST', `/api/data/${dbId}/rate-limit`, {
        token: userToken,
        body: { rules: [[key, 2, 60_000]] },
      });
      assert.equal(first.status, 200);
      let rule = first.json.data.results[0];
      assert.equal(rule.count, 1);
      assert.equal(rule.allowed, true);
      assert.equal(rule.remaining, 1);
      assert.ok(rule.resetMs > 0, 'window armed on first hit');

      const second = await call('POST', `/api/data/${dbId}/rate-limit`, {
        token: userToken,
        body: { rules: [[key, 2, 60_000]] },
      });
      rule = second.json.data.results[0];
      assert.equal(rule.count, 2);
      assert.equal(rule.allowed, true);
      assert.equal(rule.remaining, 0);

      const third = await call('POST', `/api/data/${dbId}/rate-limit`, {
        token: userToken,
        body: { rules: [[key, 2, 60_000]] },
      });
      rule = third.json.data.results[0];
      assert.equal(rule.count, 3);
      assert.equal(rule.allowed, false);
      assert.equal(rule.remaining, 0);

      // Compound: several rules in ONE call; counters independent (fresh key).
      const compound = await call('POST', `/api/data/${dbId}/rate-limit`, {
        token: userToken,
        body: { rules: [['rl:a', 1, 60_000], ['rl:b', 10, 30_000], [key, 5, 60_000]] },
      });
      const [ra, rb, rc] = compound.json.data.results;
      assert.equal(ra.count, 1);
      assert.equal(rb.count, 1);
      assert.equal(rc.count, 4, 'existing counter continued, unaffected by others');
      assert.ok(ra.resetMs <= 60_000 && rb.resetMs <= 30_000);
    });

    await step('rate-limit: fixed window expires and re-arms', async () => {
      // Tiny window (1s): the fresh counter expires, the next hit re-arms at 1.
      const armed = await call('POST', `/api/data/${dbId}/rate-limit`, {
        token: userToken,
        body: { rules: [['rl:short:1', 5, 1000]] },
      });
      assert.equal(armed.json.data.results[0].allowed, true);
      await new Promise((r) => setTimeout(r, 1100));
      const reArmed = await call('POST', `/api/data/${dbId}/rate-limit`, {
        token: userToken,
        body: { rules: [['rl:short:1', 5, 1000]] },
      });
      assert.equal(reArmed.json.data.results[0].count, 1, 'expired counter reset to 1');
      assert.ok(reArmed.json.data.results[0].resetMs > 0);
    });

    await step('quota: value size is enforced', async () => {
      process.env.QUOTA_MAX_VALUE_BYTES = '64'; // read at user creation only; use admin patch instead
      const patched = await call('PATCH', `/api/users/${(await call('GET', '/api/auth/me', { token: userToken })).json.data.user.id}`, {
        token: adminToken,
        body: { maxValueBytes: 32 },
      });
      assert.equal(patched.status, 200);

      const { status, json } = await call('PUT', `/api/data/${dbId}/strings/blobkey`, {
        token: userToken,
        body: { value: 'x'.repeat(64) },
      });
      assert.equal(status, 403);
      assert.equal(json.error.code, 'ERR_QUOTA_EXCEEDED');

      await call('PATCH', `/api/users/${(await call('GET', '/api/auth/me', { token: userToken })).json.data.user.id}`, {
        token: adminToken,
        body: { maxValueBytes: 524288 },
      });
    });

    await step('quota: database count is enforced', async () => {
      const me = await call('GET', '/api/auth/me', { token: userToken });
      for (let i = 0; i < me.json.data.user.quota.maxDatabases - 1; i += 1) {
        await call('POST', '/api/databases', { token: userToken, body: { name: `extra-${i}` } });
      }
      const { status, json } = await call('POST', '/api/databases', {
        token: userToken,
        body: { name: 'over-limit' },
      });
      assert.equal(status, 403);
      assert.equal(json.error.code, 'ERR_QUOTA_EXCEEDED');
    });

    await step('api keys: create once, use on data plane, revoke', async () => {
      const { json } = await call('POST', '/api/api-keys', {
        token: userToken,
        body: { name: 'CI pipeline', databaseId: dbId, permission: 'read-write' },
      });
      assert.equal(json.status === undefined ? true : json.status, true);
      const plaintext = json.data.plaintext;
      assert.ok(plaintext.startsWith('rk_'));
      assert.ok(!plaintext.includes(json.data.apiKey.id));
      assert.equal(json.data.apiKey.permission, 'read-write');
      assert.equal(json.data.apiKey.database.id, dbId);

      const listJson = await call('GET', '/api/api-keys', { token: userToken });
      const listed = listJson.json.data.apiKeys[0];
      assert.ok(listed.plaintext === undefined);
      assert.equal(listed.database.id, dbId);

      const list2 = await call('GET', '/api/auth/me', { token: plaintext });
      assert.equal(list2.status, 200);
      assert.equal(list2.json.data.user.email, 'owner@test.dev');

      const cmdResp = await call('POST', `/api/data/${dbId}/command`, {
        token: plaintext,
        body: { command: 'SET', args: ['via:apikey', 'works'] },
      });
      assert.equal(cmdResp.json.data.result, 'OK');

      const revoke = await call('DELETE', `/api/api-keys/${json.data.apiKey.id}`, { token: userToken });
      assert.equal(revoke.json.data.revoked, true);

      const afterRevocation = await call('GET', '/api/api-keys', { token: plaintext });
      assert.equal(afterRevocation.status, 401);
    });

    await step('api keys: scoping and permissions are enforced', async () => {
      const list = await call('GET', '/api/databases', { token: userToken });
      const otherDb = list.json.data.databases.find((db) => db.id !== dbId);
      assert.ok(otherDb, 'expected a second database from the quota step');

      // Read-write scoped key: works on its database only.
      const createRw = await call('POST', '/api/api-keys', {
        token: userToken,
        body: { name: 'scoped rw', databaseId: dbId, permission: 'read-write' },
      });
      assert.equal(createRw.status, 201);
      const rw = createRw.json.data.plaintext;

      const strangWrite = await call('POST', `/api/data/${otherDb.id}/command`, {
        token: rw, body: { command: 'SET', args: ['sneaky', 'x'] },
      });
      assert.equal(strangWrite.status, 404); // never confirm other tenants' resources
      const strangBrowse = await call('GET', `/api/data/${otherDb.id}/keys`, { token: rw });
      assert.equal(strangBrowse.status, 404);

      const ownWrite = await call('POST', `/api/data/${dbId}/command`, {
        token: rw, body: { command: 'SET', args: ['scoped', 'ok'] },
      });
      assert.equal(ownWrite.json.data.result, 'OK');
      const ownRead = await call('POST', `/api/data/${dbId}/command`, {
        token: rw, body: { command: 'GET', args: ['scoped'] },
      });
      assert.equal(ownRead.json.data.result, 'ok');
      await call('DELETE', `/api/api-keys/${createRw.json.data.apiKey.id}`, { token: userToken });

      // Read-only scoped key: reads allowed, every write refused (403).
      const createRo = await call('POST', '/api/api-keys', {
        token: userToken,
        body: { name: 'readonly', databaseId: dbId, permission: 'read-only' },
      });
      assert.equal(createRo.status, 201);
      assert.equal(createRo.json.data.apiKey.permission, 'read-only');
      const ro = createRo.json.data.plaintext;

      const deniedCommand = await call('POST', `/api/data/${dbId}/command`, {
        token: ro, body: { command: 'SET', args: ['clobber', 'x'] },
      });
      assert.equal(deniedCommand.status, 403);
      assert.equal(deniedCommand.json.error.code, 'ERR_FORBIDDEN');
      const deniedPipeline = await call('POST', `/api/data/${dbId}/pipeline`, {
        token: ro, body: { commands: [{ command: 'SET', args: ['clobber', 'x'] }, { command: 'GET', args: ['scoped'] }] },
      });
      assert.equal(deniedPipeline.status, 403);
      const deniedPut = await call('PUT', `/api/data/${dbId}/strings/rest-write`, { token: ro, body: { value: 'v' } });
      assert.equal(deniedPut.status, 403);
      const deniedDelete = await call('DELETE', `/api/data/${dbId}/keys/scoped`, { token: ro });
      assert.equal(deniedDelete.status, 403);
      const deniedExpire = await call('POST', `/api/data/${dbId}/keys/scoped/expire`, { token: ro, body: { expiresInMs: 60000 } });
      assert.equal(deniedExpire.status, 403);

      const readOk = await call('POST', `/api/data/${dbId}/command`, {
        token: ro, body: { command: 'GET', args: ['scoped'] },
      });
      assert.equal(readOk.json.data.result, 'ok');
      const readBrowse = await call('GET', `/api/data/${dbId}/keys`, { token: ro });
      assert.equal(readBrowse.status, 200);

      // Session flush via settings danger zone.
      const flush = await call('POST', `/api/databases/${dbId}/flush`, { token: userToken });
      assert.equal(flush.json.data.flushed, true);
      const afterFlush = await call('POST', `/api/data/${dbId}/command`, {
        token: userToken, body: { command: 'GET', args: ['scoped'] },
      });
      assert.equal(afterFlush.json.data.result, null);

      await call('DELETE', `/api/api-keys/${createRo.json.data.apiKey.id}`, { token: userToken });
      const revokedAccess = await call('POST', `/api/data/${dbId}/command`, {
        token: ro, body: { command: 'GET', args: ['scoped'] },
      });
      assert.equal(revokedAccess.status, 401);

      // Scoped key creation against an unknown database is rejected.
      const bogus = await call('POST', '/api/api-keys', {
        token: userToken,
        body: { name: 'bogus', databaseId: 'rdb_doesnotexist', permission: 'read-write' },
      });
      assert.equal(bogus.status, 404);
    });

    await step('api keys: exactly one active key per database is enforced', async () => {
      // Create via the database-scoped endpoint (databaseId from the path).
      const nested = await call('POST', `/api/databases/${dbId}/api-keys`, {
        token: userToken,
        body: { name: 'solo', permission: 'read-write' },
      });
      assert.equal(nested.status, 201);
      const soloId = nested.json.data.apiKey.id;

      // GET returns the active key metadata (never plaintext) for the owner.
      const current = await call('GET', `/api/databases/${dbId}/api-key`, { token: userToken });
      assert.equal(current.status, 200);
      assert.equal(current.json.data.apiKey.id, soloId);
      assert.equal(current.json.data.apiKey.plaintext, undefined);

      // A second key for the same database is rejected from both endpoints.
      const dupeFlat = await call('POST', '/api/api-keys', {
        token: userToken,
        body: { name: 'dupe', databaseId: dbId },
      });
      assert.equal(dupeFlat.status, 409);
      assert.equal(dupeFlat.json.error.code, 'ERR_CONFLICT');
      const dupeNested = await call('POST', `/api/databases/${dbId}/api-keys`, {
        token: userToken,
        body: { name: 'dupe' },
      });
      assert.equal(dupeNested.status, 409);
      assert.equal(dupeNested.json.error.code, 'ERR_CONFLICT');

      // Unknown database is a clean 404.
      const unknownDb = await call('GET', '/api/databases/rdb_neverexisted/api-key', { token: userToken });
      assert.equal(unknownDb.status, 404);

      // Rotation: revoke, then the database accepts a new key again.
      await call('DELETE', `/api/api-keys/${soloId}`, { token: userToken });
      const rotation = await call('POST', `/api/databases/${dbId}/api-keys`, {
        token: userToken,
        body: { name: 'rotation' },
      });
      assert.equal(rotation.status, 201);
      await call('DELETE', `/api/api-keys/${rotation.json.data.apiKey.id}`, { token: userToken });
    });

    await step('admin: user patch can suspend and rotate sessions', async () => {
      const me = await call('GET', '/api/auth/me', { token: userToken });
      const { status, json } = await call('PATCH', `/api/users/${me.json.data.user.id}`, {
        token: adminToken,
        body: { status: 'suspended' },
      });
      assert.equal(status, 200);
      assert.equal(json.data.user.status, 'suspended');

      const blocked = await call('GET', '/api/databases', { token: userToken });
      assert.equal(blocked.status, 401);

      await call('PATCH', `/api/users/${me.json.data.user.id}`, {
        token: adminToken,
        body: { status: 'active' },
      });
      const restored = await call('POST', '/api/auth/login', {
        body: { email: 'owner@test.dev', password: 'super-secret-9' },
      });
      assert.equal(restored.status, 200);
      userToken = restored.json.data.token;
    });

    await step('admin: non-admins are rejected on /api/users', async () => {
      const { status } = await call('GET', '/api/users', { token: userToken });
      assert.equal(status, 403);
    });

    await step('rate limit: public endpoints throttle after burst', async () => {
      let saw429 = false;
      for (let i = 0; i < 40; i += 1) {
        const { status } = await call('POST', '/api/auth/login', {
          body: { email: 'rate@t.dev', password: 'super-secret-9' },
        });
        if (status === 429) { saw429 = true; break; }
      }
      assert.equal(saw429, true);
    });

    await step('delete: database deletion cascades keys', async () => {
      const list = await call('GET', '/api/databases', { token: userToken });
      const target = list.json.data.databases.find((db) => db.name.startsWith('extra-'));
      const del = await call('DELETE', `/api/databases/${target.id}`, { token: userToken });
      assert.equal(del.json.data.deleted, true);
      const after = await call('GET', `/api/databases/${target.id}`, { token: userToken });
      assert.equal(after.status, 404);
    });

    console.log('\nAll smoke tests passed.');
  } finally {
    server.close();
    // Drop the isolated per-run Atlas test database so smoke runs never
    // accumulate collections; production metadata stays untouched by design.
    const mongo = require('../server/modules/integrations/mongo');
    await mongo.db()
      .then((db) => db.dropDatabase())
      .then(() => console.log('ok - smoke database dropped from Atlas'))
      .catch((err) => console.warn(`smoke database drop failed: ${err.message}`));
    await mongo.close();
    setTimeout(() => process.exit(0), 50);
  }
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
