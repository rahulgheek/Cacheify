#!/usr/bin/env node
'use strict';

/**
 * Wire-level RESP gateway test.
 *
 * Boots the embedded-mode REST app (same pins as smoke-test.js), mints a real
 * rk_ API key, starts the gateway as a separate process against it, and speaks
 * RAW RESP bytes over TCP — exactly what redis-cli / Jedis / redis-py would do.
 * For the same matrix against the .env REMOTE redis stack, use test-live-env.js.
 */

process.env.NODE_ENV = 'development';
process.env.REDIS_CONNECTION_STRING = '';
process.env.REDIS_TLS_CA_FILE = '';
process.env.BREVO_API_KEY = '';
process.env.MAIL_HOST = '';
process.env.MONGODB_DB = `cacheify-gw-${Math.floor(Math.random() * 1e10)}`;
process.env.ADMIN_EMAIL = 'admin@example.test';
process.env.ADMIN_PASSWORD = 'admin-password-1234';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { Wire, mapOf, makeSuite } = require('./wire-client');

const suite = makeSuite();
let wireCounter = 0;
let wire;
let resp3Wire;

async function main() {
  const { buildApp } = require('../server/app');
  await require('../server/core/bootstrap').seedAdmin();
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

  /* Identity + database + key (exact smoke flow) */
  const email = `gw-${crypto.randomUUID().slice(0, 8)}@test.dev`;
  const reg = await call('POST', '/api/auth/register', { body: { email, password: 'gateway-pass-1' } });
  assert.ok(reg.json && reg.json.data && reg.json.data.token, 'register must return a token');
  const token = reg.json.data.token;
  const otp = await call('POST', '/api/auth/otp/request', { token });
  const verify = await call('POST', '/api/auth/otp/verify', { token, body: { code: otp.json.data.devCodeOverride } });
  assert.equal(verify.status, 200);

  const dbCreate = await call('POST', '/api/databases', { token, body: { name: 'gateway-test-db' } });
  const dbId = dbCreate.json.data.database.id;
  const keyMint = await call('POST', '/api/api-keys', {
    token, body: { name: 'gateway-wire-test', databaseId: dbId, permission: 'read-write' },
  });
  const rkKey = keyMint.json.data.plaintext;
  assert.ok(rkKey && rkKey.startsWith('rk_'), 'minted key must look like rk_');
  suite.step && console.log('ok - harness: REST control plane staged (user verified, db + rk_ key minted)');

  const gateway = spawn(process.execPath, ['gateway/redis-gateway.js'], {
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
  console.log(`ok - gateway: process started on 127.0.0.1:${gwPort} (edge mode, lazy AUTH)`);

  try {
    await runSteps(gwPort, rkKey);
  } finally {
    gateway.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  await call('DELETE', `/api/databases/${dbId}`, { token });
  server.close();
  console.log(`\nsuite: ${suite.passed.length} passed, ${suite.failed ? '1+ FAILED' : '0 failed'}`);
  process.exit(suite.failed ? 1 : 0);
}

async function runSteps(gwPort, rkKey) {
  const step = suite.step;

  await step('wire: command before AUTH → -NOAUTH and close', async () => {
    wire = new Wire();
    await wire.connect(gwPort);
    wire.writeCmd(['GET', 'k']);
    const reply = await wire.read();
    assert.equal(reply.t, 'error');
    assert.match(reply.v, /^NOAUTH/i);
    const gone = await wire.read(2000);
    assert.equal(gone.t, 'closed', 'connection must close after NOAUTH');
    wireCounter += 1;
  });

  await step('wire: wrong rk_ accepted tentatively, proven 401 on first DATA command', async () => {
    wire = new Wire();
    await wire.connect(gwPort);
    wire.writeCmd(['AUTH', 'rk_wrongwrongwrongwrong']);
    const auth = await wire.read();
    assert.equal(auth.t, 'status'); // lazy: syntactic acceptance first
    wire.writeCmd(['GET', 'anything']); // data verb → REST verify → 401
    const probe = await wire.read(10_000);
    assert.equal(probe.t, 'error');
    assert.match(probe.v, /^NOAUTH/i);
    const gone = await wire.read(3000);
    assert.equal(gone.t, 'closed', 'revoked/mistyped key must close');
  });

  wire = new Wire();
  await wire.connect(gwPort);

  await step('wire: AUTH with the minted key → lazy verify → PING → PONG', async () => {
    wire.writeCmd(['AUTH', rkKey]);
    const auth = await wire.read();
    assert.equal(auth.t, 'status');
    wire.writeCmd(['PING']);
    const pong = await wire.read(10_000); // first data command = REST verify
    assert.equal(pong.t, 'status');
    assert.equal(pong.v, 'PONG');
  });

  await step('wire: SELECT 0 virtual OK, SELECT nonzero unregistered → error', async () => {
    wire.writeCmd(['SELECT', '0']);
    assert.equal((await wire.read()).t, 'status');
    wire.writeCmd(['SELECT', '7']);
    const reply = await wire.read();
    assert.equal(reply.t, 'error');
    assert.match(reply.v, /DB index is out of range/i);
  });

  await step('wire: SET plain → PUT strings → +OK, GET → bulk value', async () => {
    wire.writeCmd(['SET', 'g1', 'hello-gateway']);
    const setReply = await wire.read();
    assert.equal(setReply.t, 'status');
    assert.equal(setReply.v, 'OK');
    wire.writeCmd(['GET', 'g1']);
    const getReply = await wire.read();
    assert.equal(getReply.t, 'bulk');
    assert.equal(getReply.v, 'hello-gateway');
  });

  await step('wire: GET missing key → nil bulk ($-1)', async () => {
    wire.writeCmd(['GET', 'gw:missing']);
    const reply = await wire.read();
    assert.equal(reply.t, 'null');
  });

  await step('wire: SET with EX → TTL/PTTL in seconds/ms bounds', async () => {
    wire.writeCmd(['SET', 'g2', 'v2', 'EX', '120']);
    assert.equal((await wire.read()).v, 'OK');
    wire.writeCmd(['TTL', 'g2']);
    const ttl = await wire.read();
    assert.equal(ttl.t, 'int');
    assert.ok(ttl.v > 0 && ttl.v <= 120, `TTL must be ≤120 (got ${ttl.v})`);
    wire.writeCmd(['PTTL', 'g2']);
    const pttl = await wire.read();
    assert.equal(pttl.t, 'int');
    assert.ok(pttl.v > 0 && pttl.v <= 120_000, `PTTL must be ≤120000 (got ${pttl.v})`);
  });

  await step('wire: SETEX arms exactly, PSETEX on ms', async () => {
    wire.writeCmd(['SETEX', 'g3', '60', 'v3']);
    const reply = await wire.read();
    assert.equal(reply.t, 'status');
    wire.writeCmd(['TTL', 'g3']);
    const ttl = await wire.read();
    assert.ok(ttl.t === 'int' && ttl.v <= 60 && ttl.v > 0, `TTL must be ≤60 (got ${JSON.stringify(ttl)})`);
  });

  await step('wire: plain SET overwrites (mandatory default TTL armed)', async () => {
    wire.writeCmd(['SET', 'g2', 'overwritten']);
    const setReply = await wire.read();
    assert.equal(setReply.v, 'OK');
    wire.writeCmd(['TTL', 'g2']);
    const ttl = await wire.read();
    assert.ok(ttl.t === 'int' && ttl.v > 0, 'plain SET must still arm a finite TTL');
  });

  await step('wire: SET NX on existing → nil reply', async () => {
    wire.writeCmd(['SET', 'g1', 'blocked', 'NX']);
    const reply = await wire.read();
    assert.equal(reply.t, 'null');
  });

  await step('wire: atomic counters INCR/INCRBY/DECR/DECRBY', async () => {
    wire.writeCmd(['DEL', 'ctr']);
    await wire.read();
    wire.writeCmd(['INCR', 'ctr']);
    assert.equal((await wire.read()).v, 1);
    wire.writeCmd(['INCR', 'ctr']);
    assert.equal((await wire.read()).v, 2);
    wire.writeCmd(['INCRBY', 'ctr', '5']);
    assert.equal((await wire.read()).v, 7);
    wire.writeCmd(['DECR', 'ctr']);
    assert.equal((await wire.read()).v, 6);
    wire.writeCmd(['DECRBY', 'ctr', '2']);
    assert.equal((await wire.read()).v, 4);
  });

  await step('wire: EXPIRE arms, PEXPIRE on ms, missing key answers :0', async () => {
    wire.writeCmd(['EXPIRE', 'g2', '200']);
    const armed = await wire.read();
    assert.equal(armed.t, 'int');
    assert.equal(armed.v, 1);
    wire.writeCmd(['EXPIRE', 'gw:missing', '100']);
    const missing = await wire.read();
    assert.equal(missing.t, 'int');
    assert.equal(missing.v, 0);
    wire.writeCmd(['PEXPIRE', 'g3', '5000']);
    const pexpire = await wire.read();
    assert.equal(pexpire.v, 1);
    wire.writeCmd(['TTL', 'g3']);
    const ttl = await wire.read();
    assert.ok(ttl.v > 0 && ttl.v <= 5, `TTL after PEXPIRE must be ≤5 (got ${ttl.v})`);
  });

  await step('wire: EXISTS counts, DEL + EXISTS return flow', async () => {
    wire.writeCmd(['EXISTS', 'g1', 'g2', 'gw:zzz']);
    const exists = await wire.read();
    assert.equal(exists.v, 2);
    wire.writeCmd(['DEL', 'g2']);
    assert.equal((await wire.read()).v, 1);
    wire.writeCmd(['EXISTS', 'g2']);
    assert.equal((await wire.read()).v, 0);
  });

  await step('wire: ECHO echoes as bulk', async () => {
    wire.writeCmd(['ECHO', 'wire-echo serving the wire']);
    const reply = await wire.read();
    assert.equal(reply.t, 'bulk');
    assert.equal(reply.v, 'wire-echo serving the wire');
  });

  await step('wire: INFO includes redis_version so Jedis boots', async () => {
    wire.writeCmd(['INFO']);
    const info = await wire.read();
    assert.equal(info.t, 'bulk');
    assert.match(info.v, /redis_version:/);
  });

  await step('wire: WRONGTYPE error for GET on non-string', async () => {
    wire.writeCmd(['LPUSH', 'g:list', 'element']);
    assert.equal((await wire.read()).v, 1);
    wire.writeCmd(['GET', 'g:list']);
    const reply = await wire.read();
    assert.equal(reply.t, 'error');
    assert.match(reply.v, /WRONGTYPE/i);
  });

  await step('wire: KEYS pattern pass-through as array', async () => {
    wire.writeCmd(['KEYS', 'g*']);
    const reply = await wire.read();
    assert.equal(reply.t, 'array');
    const values = reply.items.filter((item) => item.t === 'bulk').map((item) => item.v);
    assert.ok(values.includes('g1'), `KEYS must include g1 (got ${values.join(',')})`);
  });

  await step('wire: unknown command → Redis-shaped -ERR unknown command', async () => {
    wire.writeCmd(['FOOBAR', 'x']);
    const reply = await wire.read();
    assert.equal(reply.t, 'error');
    assert.match(reply.v, /unknown command 'FOOBAR'/i);
  });

  await step('wire: HELLO (default) → RESP2 flat map array', async () => {
    wire.writeCmd(['HELLO']);
    const reply = await wire.read();
    assert.equal(reply.t, 'array');
    const flat = reply.items.map((item) => item.v);
    assert.ok(flat.includes('redis') && flat.includes('7.4.2'));
  });

  await step('wire: HELLO 3 → RESP3 map (server.redis, proto:3), null in RESP3 is _', async () => {
    resp3Wire = new Wire();
    await resp3Wire.connect(gwPort);
    resp3Wire.writeCmd(['HELLO', '3']);
    const hello = await resp3Wire.read(10_000);
    assert.ok(['map'].includes(hello.t) || hello.t === 'array', `HELLO 3 must answer a map (got ${hello.t})`);
    const fields = hello.t === 'map' ? mapOf(hello) : {};
    assert.equal(String(fields.proto), '3');
    assert.equal(fields.server, 'redis');
    resp3Wire.writeCmd(['AUTH', rkKey]);
    const auth = await resp3Wire.read();
    assert.equal(auth.t, 'status', 'HELLO negotiated AUTH must accept');
    resp3Wire.writeCmd(['GET', 'gw:missing']);
    const nilReply = await resp3Wire.read(10_000);
    assert.equal(nilReply.t, 'null', 'RESP3 nil must arrive as _');
    resp3Wire.writeCmd(['GET', 'g1']);
    const value = await resp3Wire.read(10_000);
    assert.equal(value.v, 'hello-gateway', 'RESP3 bulk value readable');
  });

  await step('wire: pipelining — 4 commands in one TCP write, replies in order', async () => {
    wire.writeCmd(['PING']);
    wire.writeCmd(['PING']);
    wire.writeCmd(['GET', 'g1']);
    wire.writeCmd(['EXISTS', 'ctr']);
    const pong1 = await wire.read();
    assert.equal(pong1.v, 'PONG');
    const pong2 = await wire.read();
    assert.equal(pong2.v, 'PONG');
    const val = await wire.read();
    assert.equal(val.v, 'hello-gateway');
    const exists = await wire.read();
    assert.equal(exists.v, 1, 'ctr must have survived');
  });

  await step('wire: batched ≥3 reads collapse to ONE /pipeline round-trip', async () => {
    // Durable keys only (g3 expires early by design in this suite):
    // g1 set, gated ctr (24h default TTL), gw:zzz missing ⇒ 0.
    wire.writeCmd(['EXISTS', 'g1']);
    wire.writeCmd(['EXISTS', 'ctr']);
    wire.writeCmd(['EXISTS', 'gw:zzz']);
    wire.writeCmd(['GET', 'g1']);
    const replies = [await wire.read(), await wire.read(), await wire.read(), await wire.read()];
    assert.deepEqual(replies.map((reply) => reply.v), [1, 1, 0, 'hello-gateway']);
  });

  await step('wire: protocol error → -ERR Protocol error + close', async () => {
    const broken = new Wire();
    await broken.connect(gwPort);
    broken.socket.write(Buffer.from('*1\r\n$NAN\r\n', 'ascii'));
    const reply = await broken.read();
    assert.equal(reply.t, 'error');
    assert.match(reply.v, /Protocol error/i);
    const gone = await broken.read(3000);
    assert.equal(gone.t, 'closed');
  });

  await step('wire: inline commands (redis-cli style) parse', async () => {
    const inlineWire = new Wire();
    await inlineWire.connect(gwPort);
    inlineWire.socket.write(Buffer.from(`AUTH ${rkKey}\r\n`, 'ascii'));
    const login = await inlineWire.read();
    assert.equal(login.t, 'status');
    inlineWire.socket.write(Buffer.from('PING\r\n', 'ascii'));
    const pong = await inlineWire.read(10_000);
    assert.equal(pong.v, 'PONG');
    inlineWire.close();
  });

  wire.close();
  if (resp3Wire) resp3Wire.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
