#!/usr/bin/env node
'use strict';

/**
 * LIVE-ENV RESP gateway test: runs the full wire matrix against the .env
 * configuration — real remote Redis (rediss://), real Atlas metadata, gateway
 * as a separate process. This is production parity: client bytes → gateway →
 * REST → ioredis → the actual Redis server.
 *
 * Safety rails:
 *   - Metadata stays isolated: MONGODB_DB is pinned to cacheify-live-<rand>
 *     (dropped at the end, like smoke-test.js).
 *   - Mailer pinned to MOCK so OTP verification works without real SMTP sends;
 *     the devCodeOverride flow is the same one smoke exercises.
 *   - Data-plane keys live in one throwaway namespace and are fully cleaned up
 *     by DELETE /databases/:id (remote namespace wipe) before the metadata row.
 *
 * Usage:  npm run test:gateway:live   (from backend/)
 */

process.env.NODE_ENV = 'development';
// Isolated metadata db on the SAME Atlas cluster (never production data).
process.env.MONGODB_DB = `cacheify-live-${Math.floor(Math.random() * 1e10)}`;
// Mock mail: .env never overrides existing keys, so this blocks real SMTP.
process.env.BREVO_API_KEY = '';
process.env.MAIL_HOST = '';

const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
/* Cwd-independent dotenv load, as in test-resp.js: the live suite needs the
   backend/.env stack configuration (Atlas metadata, operator Redis endpoint,
   TLS CA) regardless of the npm script's working directory. */
require('../backend/node_modules/dotenv').config({ path: path.resolve(__dirname, '../backend/.env') });
const { config } = require('../backend/server/core/env');
const { Wire, mapOf, makeSuite } = require('./wire-client');

/* Sampled wire latencies (per awaited reply), reported at the end. */
const samples = [];async function timedRead(wire, timeoutMs = 10_000) {
  const start = Date.now();
  const reply = await wire.read(timeoutMs);
  samples.push(Date.now() - start);
  return reply;
}

function percentile(list, p) {
  const sorted = [...list].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function main() {
  /* Announce what we are actually testing against. */
  const raw = process.env.REDIS_CONNECTION_STRING || config.redis.connectionString || '';
  const masked = raw.replace(/:[^:@/]+@/, ':***@');
  console.log(`mode: ${config.redis.mode}`);
  console.log(`redis: ${masked || '(embedded — .env has no REDIS_CONNECTION_STRING!)'}`);

  const { buildApp } = require('../backend/server/app');
  await require('../backend/server/core/bootstrap').seedAdmin();
  const server = buildApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, urlPath, { token, body } = {}) => {
    const res = await fetch(`${apiBase}${urlPath}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const email = `live-${crypto.randomUUID().slice(0, 8)}@test.dev`;
  const reg = await call('POST', '/api/auth/register', { body: { email, password: 'live-pass-1234' } });
  assert.ok(reg.json.data.token, 'register must return a token');
  const token = reg.json.data.token;
  const otp = await call('POST', '/api/auth/otp/request', { token });
  const verify = await call('POST', '/api/auth/otp/verify', { token, body: { code: otp.json.data.devCodeOverride } });
  assert.equal(verify.status, 200);
  const dbCreate = await call('POST', '/api/databases', { token, body: { name: 'gateway-live-db' } });
  const dbId = dbCreate.json.data.database.id;
  const keyMint = await call('POST', '/api/api-keys', {
    token, body: { name: 'gateway-live-wire', databaseId: dbId, permission: 'read-write' },
  });
  const rkKey = keyMint.json.data.plaintext;
  assert.ok(rkKey.startsWith('rk_'));
  console.log(`ok - harness: user verified, db ${dbId.slice(0, 12)}…, rk_ key minted`);

  const gateway = spawn(process.execPath, [path.join(__dirname, 'redis-gateway.js')], {
    env: {
      ...process.env,
      CACHEIFY_BASE_URL: apiBase,
      CACHEIFY_API_KEY: rkKey,
      CACHEIFY_DB_ID: dbId,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: '0',
      GATEWAY_DEBUG: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const gwLog = [];
  gateway.stdout.on('data', (chunk) => gwLog.push(String(chunk).trim()));
  gateway.stderr.on('data', (chunk) => gwLog.push(`W| ${String(chunk).trim()}`));
  global.__gwLog = gwLog;
  global.__raw = [];

  const gwPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway did not announce its port')), 8000);
    gateway.stdout.on('data', (chunk) => {
      const match = chunk.toString().match(/port=(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    gateway.on('exit', (code) => reject(new Error(`gateway exited early code=${code}`)));
  });
  console.log(`ok - gateway: spawned on 127.0.0.1:${gwPort} (edge mode, lazy AUTH)`);

  const suite = makeSuite();
  try {
    await runSteps(suite, gwPort, rkKey, call, token);
  } finally {
    gateway.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  /* Cleanup: DELETE cascades the remote namespace (real Redis wipe) + row. */
  const del = await call('DELETE', `/api/databases/${dbId}`, { token });
  console.log(`cleanup: database delete ${del.status} deleted=${del.json?.data?.deleted}`);
  for (const extraId of extraDatabases) {
    const delExtra = await call('DELETE', `/api/databases/${extraId}`, { token });
    console.log(`cleanup: extra database delete ${delExtra.status} deleted=${delExtra.json?.data?.deleted}`);
  }
  server.close();
  await require('../backend/server/modules/data/remote-driver').close().catch(() => {});
  const mongo = require('../backend/server/modules/integrations/mongo');
  await mongo.db().then((db) => db.dropDatabase()).catch((err) => console.warn(`atlas drop failed: ${err.message}`));
  await mongo.close().catch(() => {});

  /* Latency report (client-visible wire round-trips through the full stack). */
  if (samples.length > 0) {
    console.log('\nlatency (wire → gateway → REST → remote Redis → back):');
    console.log(`  samples n=${samples.length} p50=${percentile(samples, 50)}ms p95=${percentile(samples, 95)}ms max=${Math.max(...samples)}ms`);
  }
  console.log(`\nsuite: ${suite.passed.length} passed, ${suite.failed ? '1+ FAILED' : '0 failed'}`);
  process.exit(suite.failed ? 1 : 0);
}

let sharedWire;
let resp3Wire;
const extraDatabases = [];

async function runSteps(suite, gwPort, rkKey, call, token) {
  await suite.step('wire: command before AUTH → -NOAUTH and close', async () => {
    const wire = new Wire();
    await wire.connect(gwPort);
    wire.writeCmd(['GET', 'k']);
    const reply = await timedRead(wire);
    assert.equal(reply.t, 'error');
    assert.match(reply.v, /^NOAUTH/i);
    const gone = await wire.read(3000);
    assert.equal(gone.t, 'closed', 'connection must close after NOAUTH');
  });

  await suite.step('wire: wrong rk_ accepted tentatively, proven 401 on first DATA command', async () => {
    const wire = new Wire();
    await wire.connect(gwPort);
    wire.writeCmd(['AUTH', 'rk_wrongwrongwrongwrong']);
    const auth = await wire.read();
    assert.equal(auth.t, 'status');
    wire.writeCmd(['GET', 'anything']);
    const probe = await timedRead(wire); // hits the real REST auth
    assert.equal(probe.t, 'error');
    assert.match(probe.v, /^NOAUTH/i);
    const gone = await wire.read(3000);
    assert.equal(gone.t, 'closed', 'dead key must close the connection');
  });

  sharedWire = new Wire();
  await sharedWire.connect(gwPort);

  await suite.step('wire: AUTH with minted key → lazy verify → PING → PONG', async () => {
    sharedWire.writeCmd(['AUTH', rkKey]);
    const auth = await sharedWire.read();
    assert.equal(auth.t, 'status');
    sharedWire.writeCmd(['PING']);
    const pong = await timedRead(sharedWire);
    assert.equal(pong.t, 'status');
    assert.equal(pong.v, 'PONG');
  });

  await suite.step('wire: SELECT 0 virtual OK, SELECT 7 unregistered → error', async () => {
    sharedWire.writeCmd(['SELECT', '0']);
    assert.equal((await sharedWire.read()).t, 'status');
    sharedWire.writeCmd(['SELECT', '7']);
    const reply = await timedRead(sharedWire);
    assert.equal(reply.t, 'error');
    assert.match(reply.v, /DB index is out of range/i);
  });

  await suite.step('wire: SET plain → PUT strings → +OK, GET → bulk value', async () => {
    sharedWire.writeCmd(['SET', 'live:greeting', 'hello-remote-redis']);
    const setReply = await timedRead(sharedWire);
    assert.equal(setReply.t, 'status');
    assert.equal(setReply.v, 'OK');
    sharedWire.writeCmd(['GET', 'live:greeting']);
    const getReply = await timedRead(sharedWire);
    assert.equal(getReply.t, 'bulk');
    assert.equal(getReply.v, 'hello-remote-redis');
  });

  await suite.step('wire: GET missing key → nil ($-1)', async () => {
    sharedWire.writeCmd(['GET', 'live:missing']);
    const reply = await timedRead(sharedWire);
    assert.equal(reply.t, 'null');
  });

  await suite.step('wire: SET EX 120 → TTL/PTTL seconds/ms in bounds', async () => {
    sharedWire.writeCmd(['SET', 'live:arm120', 'v', 'EX', '120']);
    assert.equal((await timedRead(sharedWire)).v, 'OK');
    sharedWire.writeCmd(['TTL', 'live:arm120']);
    const ttl = await timedRead(sharedWire);
    assert.equal(ttl.t, 'int');
    assert.ok(ttl.v > 0 && ttl.v <= 120, `TTL ≤120 (got ${ttl.v})`);
    sharedWire.writeCmd(['PTTL', 'live:arm120']);
    const pttl = await timedRead(sharedWire);
    assert.ok(pttl.v > 0 && pttl.v <= 120_000, `PTTL ≤120000 (got ${pttl.v})`);
  });

  await suite.step('wire: plain SET re-arms mandatory default TTL (≠-1)', async () => {
    sharedWire.writeCmd(['SET', 'live:arm120', 'overwritten']);
    const setReply = await timedRead(sharedWire);
    assert.equal(setReply.v, 'OK');
    sharedWire.writeCmd(['TTL', 'live:arm120']);
    const ttl = await timedRead(sharedWire);
    assert.ok(ttl.t === 'int' && ttl.v > 0, `TTL must stay finite (got ${ttl.v})`);
    assert.ok(ttl.v > 3600, `default TTL ~24h expected (got ${ttl.v})`);
  });

  await suite.step('wire: SETEX arms exactly ≤ s; missing SETEX arg errors', async () => {
    sharedWire.writeCmd(['SETEX', 'live:setex', '60', 'v3']);
    const reply = await timedRead(sharedWire);
    assert.equal(reply.t, 'status');
    sharedWire.writeCmd(['TTL', 'live:setex']);
    const ttl = await timedRead(sharedWire);
    assert.ok(ttl.t === 'int' && ttl.v <= 60 && ttl.v > 0, `TTL ≤60 (got ${JSON.stringify(ttl)})`);
  });

  await suite.step('wire: SET NX on existing → nil reply', async () => {
    sharedWire.writeCmd(['SET', 'live:greeting', 'blocked', 'NX']);
    const reply = await timedRead(sharedWire);
    assert.equal(reply.t, 'null');
  });

  await suite.step('wire: atomic counters INCR/INCRBY/DECR/DECRBY', async () => {
    sharedWire.writeCmd(['DEL', 'live:ctr']);
    await timedRead(sharedWire);
    for (const [cmd, args, expected] of [
      ['INCR', ['live:ctr'], 1],
      ['INCR', ['live:ctr'], 2],
      ['INCRBY', ['live:ctr', '5'], 7],
      ['DECR', ['live:ctr'], 6],
      ['DECRBY', ['live:ctr', '2'], 4],
    ]) {
      sharedWire.writeCmd([cmd, ...args]);
      const reply = await timedRead(sharedWire);
      assert.ok(reply.t === 'int' && reply.v === expected, `${cmd} → ${expected} (got ${JSON.stringify(reply)})`);
    }
  });

  await suite.step('wire: EXPIRE arms (:1), PEXPIRE ms, missing key answers :0', async () => {
    sharedWire.writeCmd(['EXPIRE', 'live:arm120', '200']);
    const reply = await timedRead(sharedWire);
    assert.equal(reply.v, 1);
    sharedWire.writeCmd(['EXPIRE', 'live:missing-key', '100']);
    const missing = await timedRead(sharedWire);
    assert.equal(missing.v, 0);
    sharedWire.writeCmd(['PEXPIRE', 'live:setex', '5000']);
    const pexpire = await timedRead(sharedWire);
    assert.equal(pexpire.v, 1);
    sharedWire.writeCmd(['TTL', 'live:setex']);
    const ttl = await timedRead(sharedWire);
    assert.ok(ttl.v > 0 && ttl.v <= 5, `TTL ≤5 after PEXPIRE (got ${ttl.v})`);
  });

  await suite.step('wire: EXISTS counts, DEL + EXISTS flow', async () => {
    sharedWire.writeCmd(['EXISTS', 'live:greeting', 'live:arm120', 'live:zzz']);
    const reply = await timedRead(sharedWire);
    assert.equal(reply.v, 2);
    sharedWire.writeCmd(['DEL', 'live:arm120']);
    assert.equal((await timedRead(sharedWire)).v, 1);
    sharedWire.writeCmd(['EXISTS', 'live:arm120']);
    assert.equal((await timedRead(sharedWire)).v, 0);
  });

  await suite.step('wire: ECHO echoes as bulk', async () => {
    sharedWire.writeCmd(['ECHO', 'live-wire-echo']);
    const reply = await timedRead(sharedWire);
    assert.equal(reply.t, 'bulk');
    assert.equal(reply.v, 'live-wire-echo');
  });

  await suite.step('wire: INFO includes redis_version (Jedis boot requirement)', async () => {
    sharedWire.writeCmd(['INFO']);
    const info = await timedRead(sharedWire);
    assert.equal(info.t, 'bulk');
    assert.match(info.v, /redis_version:/);
  });

  await suite.step('wire: WRONGTYPE error for GET on real Redis list', async () => {
    sharedWire.writeCmd(['LPUSH', 'live:list', 'element']);
    assert.equal((await timedRead(sharedWire)).v, 1);
    sharedWire.writeCmd(['GET', 'live:list']);
    const reply = await timedRead(sharedWire);
    assert.equal(reply.t, 'error');
    assert.match(reply.v, /WRONGTYPE/i);
  });

  await suite.step('wire: KEYS pattern → array of remote names', async () => {
    sharedWire.writeCmd(['KEYS', 'live:*']);
    const reply = await timedRead(sharedWire);
    assert.equal(reply.t, 'array');
    const values = reply.items.filter((item) => item.t === 'bulk').map((item) => item.v);
    assert.ok(values.includes('live:greeting'), `KEYS must include live:greeting (got ${values.join(',')})`);
  });

  await suite.step('wire: unknown command → redis-shaped -ERR', async () => {
    sharedWire.writeCmd(['FOOBAR', 'x']);
    const reply = await timedRead(sharedWire);
    assert.equal(reply.t, 'error');
    assert.match(reply.v, /unknown command 'FOOBAR'/i);
  });

  await suite.step('wire: HELLO (default) → RESP2 flat map array', async () => {
    sharedWire.writeCmd(['HELLO']);
    const reply = await timedRead(sharedWire);
    assert.equal(reply.t, 'array');
    const flat = reply.items.map((item) => item.v);
    assert.ok(flat.includes('redis') && flat.includes('7.4.2'));
  });

  await suite.step('wire: HELLO 3 → RESP3 map, null-style (_) reply, bulk value', async () => {
    resp3Wire = new Wire();
    await resp3Wire.connect(gwPort);
    resp3Wire.writeCmd(['HELLO', '3']);
    const hello = await timedRead(resp3Wire);
    assert.ok(['map'].includes(hello.t));
    const fields = mapOf(hello);
    assert.equal(String(fields.proto), '3');
    assert.equal(fields.server, 'redis');
    resp3Wire.writeCmd(['AUTH', rkKey]);
    assert.equal((await resp3Wire.read()).t, 'status');
    resp3Wire.writeCmd(['GET', 'live:missing']);
    const nilReply = await timedRead(resp3Wire);
    assert.equal(nilReply.t, 'null', 'RESP3 nil must arrive as _');
    resp3Wire.writeCmd(['GET', 'live:greeting']);
    const value = await timedRead(resp3Wire);
    assert.equal(value.v, 'hello-remote-redis');
  });

  await suite.step('wire: pipelining — 4 commands, one TCP write, in-order replies', async () => {
    sharedWire.writeCmd(['PING']);
    sharedWire.writeCmd(['PING']);
    sharedWire.writeCmd(['GET', 'live:greeting']);
    sharedWire.writeCmd(['EXISTS', 'live:ctr']);
    const pong1 = await timedRead(sharedWire);
    assert.equal(pong1.v, 'PONG');
    const pong2 = await timedRead(sharedWire);
    assert.equal(pong2.v, 'PONG');
    const val = await timedRead(sharedWire);
    assert.equal(val.v, 'hello-remote-redis');
    const exists = await timedRead(sharedWire);
    assert.equal(exists.v, 1);
  });

  await suite.step('wire: batched ≥3 reads → ONE /pipeline round-trip', async () => {
    sharedWire.writeCmd(['EXISTS', 'live:greeting']);
    sharedWire.writeCmd(['EXISTS', 'live:ctr']);
    sharedWire.writeCmd(['EXISTS', 'live:missing-key']);
    sharedWire.writeCmd(['GET', 'live:greeting']);
    const replies = [
      await timedRead(sharedWire), await timedRead(sharedWire),
      await timedRead(sharedWire), await timedRead(sharedWire),
    ];
    assert.deepEqual(replies.map((reply) => reply.v), [1, 1, 0, 'hello-remote-redis']);
  });

  await suite.step('wire: protocol error → -ERR Protocol error + close', async () => {
    const broken = new Wire();
    await broken.connect(gwPort);
    broken.socket.write(Buffer.from('*1\r\n$NAN\r\n', 'ascii'));
    const reply = await broken.read();
    assert.equal(reply.t, 'error');
    assert.match(reply.v, /Protocol error/i);
    const gone = await broken.read(3000);
    assert.equal(gone.t, 'closed');
  });

  await suite.step('wire: inline commands (redis-cli style) parse', async () => {
    const inlineWire = new Wire();
    await inlineWire.connect(gwPort);
    inlineWire.socket.write(Buffer.from(`AUTH ${rkKey}\r\n`, 'ascii'));
    const login = await inlineWire.read();
    assert.equal(login.t, 'status');
    inlineWire.socket.write(Buffer.from('PING\r\n', 'ascii'));
    const pong = await timedRead(inlineWire);
    assert.equal(pong.v, 'PONG');
    inlineWire.close();
  });

  sharedWire.close();
  if (resp3Wire) resp3Wire.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
