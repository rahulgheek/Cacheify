'use strict';

/**
 * Cacheify RESP gateway: speaks the Redis wire protocol (RESP2 + RESP3) and
 * translates every command onto the existing HTTPS data plane (Bearer rk_ key),
 * so ANY standard Redis client (redis-cli, Jedis, Lettuce, redis-py,
 * node-redis, go-redis) can use Cacheify with just a URL — with ZERO changes
 * to the REST contract.
 *
 *   redis client ⟷ [net/tls] ⟷ [RESP codec] ⟷ [CMD translator]
 *                ⟷ [shared HTTP keep-alive pool] ⟷ Cacheify REST /api/data/…
 *
 * Command translation
 *   - Read verbs / everything engine-registered → POST /command (pass-through:
 *     native semantics incl. WRONGTYPE, nil, atomic counters, KEYS, SCAN)
 *   - SET plain / EX / PX and SETEX/PSETEX → PUT /strings/{k}: the convenience
 *     write path that always arms a TTL (the mandatory-expiry model). NX/XX
 *     and exotic modifiers stay verbatim on the command plane.
 *   - EXPIRE/PEXPIRE → POST /keys/{k}/expire
 *   - AUTH password == the Bearer rk_ API key; verified lazily on the first
 *     data command (401 → -NOAUTH Authentication required + close)
 *   - SELECT index → registry lookup (CACHEIFY_DB_MAP / CACHEIFY_DB_ID); index
 *     0 is always +OK (virtual). Multi-db = one AUTH key per database — honest
 *     about the one-active-key-per-db tenant model.
 *   - HELLO 2|3 supported (RESP3 emit). INFO/CLIENT/CONFIG/COMMAND are
 *     answered locally so client libraries boot cleanly.
 *
 * Reliability
 *   - Shared HTTP keep-alive pool (undici default pooling) + concurrency
 *     semaphore; one amortized connection set per process, not per client conn.
 *   - 429 + Retry-After honored as a global fast-fail cooldown
 *     (-ERR RATE_LIMITED) so pipelined floods back off without hammering.
 *   - Bounded per-connection command queue (protocol-flood guard), bounded
 *     command batches (≤50 on /pipeline), bounded bulk sizes.
 *   - NO silent retries: upstream failure surfaces as a Redis error reply, so
 *     the client library's own retry policy decides.
 *
 * Env
 *   CACHEIFY_API_KEY      Bearer rk_... key (container mode)
 *   CACHEIFY_BASE_URL     default https://cacheify.bot-keep.xyz
 *   CACHEIFY_DB_ID        public id of the target database (index 0)
 *   CACHEIFY_DB_MAP       "0=rdb_aaa,1=rdb_bbb" index→database registry
 *   GATEWAY_BYPASS_AUTH   =1 → AUTH not required (localhost container mode)
 *   GATEWAY_PORT / GATEWAY_HOST    listen endpoint (default 6379 / 127.0.0.1)
 *   GATEWAY_TLS_CERT / GATEWAY_TLS_KEY   enable rediss://
 *   REST_TIMEOUT_MS(5000) MAX_REST_INFLIGHT(32) MAX_QUEUE(256)
 */

const net = require('net');
const tls = require('tls');

/* ------------------------------------------------------------------ config */

function asInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const config = {
  apiKey: process.env.CACHEIFY_API_KEY || '',
  baseUrl: (process.env.CACHEIFY_BASE_URL || 'https://cacheify.bot-keep.xyz').replace(/\/+$/, ''),
  dbId: process.env.CACHEIFY_DB_ID || '',
  bypassAuth: process.env.GATEWAY_BYPASS_AUTH === '1',
  port: asInt(process.env.GATEWAY_PORT ?? process.env.PORT ?? '6379', 6379),
  host: process.env.GATEWAY_HOST || '127.0.0.1',
  tlsCert: process.env.GATEWAY_TLS_CERT || '',
  tlsKey: process.env.GATEWAY_TLS_KEY || '',
  restTimeoutMs: asInt(process.env.REST_TIMEOUT_MS, 5000),
  maxRestInflight: asInt(process.env.MAX_REST_INFLIGHT, 32),
  maxQueue: asInt(process.env.MAX_QUEUE, 256),
  maxConnections: asInt(process.env.MAX_CONNECTIONS, 2000),
  idleTimeoutMs: asInt(process.env.GATEWAY_IDLE_TIMEOUT_MS, 300_000),
  maxBulkBytes: 512 * 1024 * 1024,
};

/** Registry: db index → public database id. Index 0 defaults to CACHEIFY_DB_ID. */
const dbRegistry = new Map();
if (config.dbId) dbRegistry.set(0, config.dbId);
for (const pair of (process.env.CACHEIFY_DB_MAP || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const match = pair.match(/^(\d+)=(rdb_.+)$/);
  if (match) dbRegistry.set(Number(match[1]), match[2]);
  else console.error(`[gateway] malformed CACHEIFY_DB_MAP entry ignored: ${pair}`);
}

const REDIS_VERSION = '7.4.2';
/**
 * Lazy auth probe: the registry has no PING, so verification uses a GET on a
 * key that cannot exist — 200 whether nil or not, 401 only for a dead key.
 */
const PROBE_KEY = '__cacheify__gateway__probe__';

function log(...args) {
  console.log('[gateway]', ...args);
}

function warn(...args) {
  console.warn('[gateway]', ...args);
}

/* ------------------------------------------------------------------- codec */

class ProtocolError extends Error {}

/**
 * Typed reply markers: every translator returns these exactly, which keeps
 * bulk-vs-status correct and makes RESP2/RESP3 emitting trivial.
 */
const st = (v) => ({ t: 'status', v });                   // +OK
const er = (v) => ({ t: 'error', v });                    // -ERR msg
const int = (n) => ({ t: 'int', v: n });                  // :7
const bulk = (v) => ({ t: 'bulk', v });                   // $len; null/undefined ⇒ nil
const arr = (items) => ({ t: 'arr', items });             // *N
const nil = () => ({ t: 'null' });                        // $-1 / _
const mapReply = (pairs) => ({ t: 'map', pairs });        // %N (RESP3) / flat (RESP2)
const STATUS_OK = st('OK');

/** Serialize typed replies for a protocol level (2 or 3). */
function encode(reply, proto) {
  const chunk = (c) => (typeof c === 'string' ? Buffer.from(c, 'utf8') : c);
  switch (reply.t) {
    case 'status': return Buffer.from(`+${reply.v}\r\n`, 'utf8');
    case 'error': return Buffer.from(`-${reply.v}\r\n`, 'utf8');
    case 'int': return Buffer.from(`:${reply.v}\r\n`, 'utf8');
    case 'null': return Buffer.from(proto >= 3 ? '_\r\n' : '$-1\r\n', 'ascii');
    case 'bulk': {
      if (reply.v === null || reply.v === undefined) {
        return Buffer.from(proto >= 3 ? '_\r\n' : '$-1\r\n', 'ascii');
      }
      const bytes = Buffer.from(String(reply.v), 'utf8');
      return Buffer.concat([
        Buffer.from(`$${bytes.length}\r\n`, 'ascii'),
        bytes,
        Buffer.from('\r\n', 'ascii'),
      ]);
    }
    case 'arr': {
      const parts = [chunk(`*${reply.items.length}\r\n`)];
      for (const item of reply.items) parts.push(encode(item, proto));
      return Buffer.concat(parts.map(chunk));
    }
    case 'map': {
      const parts = [];
      if (proto >= 3) {
        parts.push(`%${reply.pairs.length}\r\n`);
      } else {
        parts.push(`*${reply.pairs.length * 2}\r\n`); // RESP2: flat array
      }
      for (const [key, value] of reply.pairs) {
        parts.push(encode(key, proto));
        parts.push(encode(value, proto));
      }
      return Buffer.concat(parts.map(chunk));
    }
    default:
      return Buffer.from('-ERR internal gateway reply encoding\r\n', 'utf8');
  }
}

/**
 * Incremental RESP command parser.
 *
 * `parseCommands(state)` extracts every COMPLETE command currently buffered,
 * leaving partially received prefixes untouched (correct across arbitrary TCP
 * chunk boundaries). Throws ProtocolError on framing violations; the caller
 * replies `-ERR Protocol error: …` and closes, matching Redis.
 */
function parseCommands(state) {
  const commands = [];
  for (;;) {
    if (state.buffer.length === 0) break;
    const first = state.buffer[0];
    if (first === 0x0a || first === 0x0d) { // stray CRLF
      state.buffer = state.buffer.subarray(1);
      continue;
    }
    const nl = state.buffer.indexOf(0x0a);
    if (first === 0x2a) {
      // Multibulk: *N header line, then N "$len\r\n<bytes>\r\n" strings.
      if (nl === -1) {
        if (state.buffer.length > 64) throw new ProtocolError('invalid multibulk length');
        break;
      }
      const header = state.buffer.subarray(0, nl).toString('latin1').trim();
      if (!/^\*\d+$/.test(header)) throw new ProtocolError('invalid multibulk length');
      const count = Number(header.slice(1));
      if (count === 0) { state.buffer = state.buffer.subarray(nl + 1); continue; }
      if (count > 1024) throw new ProtocolError('invalid multibulk length');
      let cursor = nl + 1;
      const args = [];
      let complete = true;
      for (let i = 0; i < count; i += 1) {
        if (cursor >= state.buffer.length) { complete = false; break; }
        const headEnd = state.buffer.indexOf(0x0a, cursor);
        if (headEnd === -1) {
          if (state.buffer.length - cursor > 64) throw new ProtocolError('invalid bulk length');
          complete = false;
          break;
        }
        const head = state.buffer.subarray(cursor, headEnd).toString('latin1').trim();
        const match = head.match(/^\$(\d+)$/);
        if (!match) {
          throw new ProtocolError(`expected '$', got '${head[0] === undefined ? '?' : head[0]}'`);
        }
        const length = Number(match[1]);
        if (length > config.maxBulkBytes) throw new ProtocolError('invalid bulk length');
        const payloadStart = headEnd + 1;
        if (state.buffer.length < payloadStart + length + 2) { complete = false; break; }
        if (state.buffer[payloadStart + length] !== 0x0d || state.buffer[payloadStart + length + 1] !== 0x0a) {
          throw new ProtocolError('expected CRLF after bulk payload');
        }
        args.push(state.buffer.subarray(payloadStart, payloadStart + length).toString('utf8'));
        cursor = payloadStart + length + 2;
      }
      if (!complete) break; // keep bytes buffered; resume on the next chunk
      state.buffer = state.buffer.subarray(cursor);
      if (args.length > 0) commands.push({ name: args[0].toUpperCase(), args: args.slice(1) });
      continue;
    }
    // Inline command (e.g. "PING\r\n"): space separated words.
    if (nl === -1) {
      if (state.buffer.length > 64 * 1024) throw new ProtocolError('too big inline request');
      break;
    }
    let length = nl;
    if (length > 0 && state.buffer[length - 1] === 0x0d) length -= 1;
    const line = state.buffer.subarray(0, length).toString('utf8');
    state.buffer = state.buffer.subarray(nl + 1);
    if (line.length === 0) continue;
    const words = line.split(/[ \t]+/).filter(Boolean);
    if (words.length === 0) continue;
    commands.push({ name: words[0].toUpperCase(), args: words.slice(1) });
  }
  return commands;
}

/* -------------------------------------------------------------- REST layer */

class RateLimitedError extends Error {}

let inflight = 0;
const waiting = [];
let blockedUntil = 0;

function acquireSlot() {
  if (inflight < config.maxRestInflight) {
    inflight += 1;
    return null;
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else inflight -= 1;
}

/**
 * One REST data-plane call. Resolves to {status, json}; status → reply mapping
 * happens in the translator. Never throws for HTTP statuses — only for network
 * level problems (mapped by callers) and RateLimitedError on cooldown.
 */
async function rest(method, dbId, apiKey, urlPath, body) {
  if (Date.now() < blockedUntil) throw new RateLimitedError();
  const slot = acquireSlot();
  if (slot) await slot;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.restTimeoutMs);
    try {
      const res = await fetch(`${config.baseUrl}/api/data/${dbId}${urlPath}`, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (process.env.GATEWAY_DEBUG === '1') {
        console.log(`[gateway] rest ${method} ${dbId}${urlPath} -> ${res.status}`);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      let json = null;
      try { json = await res.json(); } catch { /* proxy bodies may not be JSON */ }
      if (res.status === 429) {
        const cooldown = Number.isFinite(retryAfter) ? Math.min(retryAfter, 60) : 1;
        blockedUntil = Date.now() + cooldown * 1000;
        throw new RateLimitedError();
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    releaseSlot();
  }
}

/* ------------------------------------------------------------ error mapping */

const RESP_CODE = /^(WRONGTYPE|NOAUTH|LOADING|BUSY|EXECABORT|NOPROTO|READONLY|MOVED|ASK|CROSSSLOT)/;

const NO_AUTH_REPLY = () => er('NOAUTH Authentication required');
const UPSTREAM_DOWN = () => er('CACHEIFY_UPSTREAM_REST_UNAVAILABLE upstream did not answer in time');
const RATE_LIMITED = () => er('RATE_LIMITED Cacheify is rate limited, retry with backoff');

/** Map an upstream failure envelope to a Redis-style error reply. */
function errorFromRest(status, json) {
  const message = (json && json.error && json.error.message) || `upstream status ${status}`;
  if (status === 401) return NO_AUTH_REPLY();
  if (status === 403) return er(`user key does not permit this operation: ${message}`);
  if (status === 404) return er('no such key');
  if (status === 413) return er('value too large for the platform');
  if (status === 422) {
    if (/unknown command/i.test(message)) {
      const name = message.match(/'([A-Za-z]+)'/);
      return er(`unknown command '${name ? name[1] : ''}'`);
    }
    const match = message.match(RESP_CODE);
    if (match) return er(`${match[1]} ${message}`);
    return er(message);
  }
  return er(`CACHEIFY_UPSTREAM ${message}`);
}

/* ------------------------------------------------------------ connection core */

/**
 * Everything a per-command call shares: lazy key verification, SELECT-aware
 * database resolution, and failure mapping. Returns {res} or {reply} ((mapped
 * error reply) — callers respond with reply when present.
 */
async function upstream(conn, method, urlPath, body) {
  if (conn.bad) return { reply: NO_AUTH_REPLY() };
  if (!conn.apiKey) { conn.bad = true; conn.closeAfterReply = true; return { reply: NO_AUTH_REPLY() }; }
  if (!conn.verified) {
    const dbId = resolveDb(conn);
    if (!dbId) return { reply: er('CACHEIFY_DB_ID not configured for the selected database index') };
    try {
      const res = await rest('POST', dbId, conn.apiKey, '/command', { command: 'GET', args: [PROBE_KEY] });
      if (res.status !== 200) {
        conn.bad = true;
        conn.closeAfterReply = true; // revoked/mistyped key: NOAUTH and close
        return { reply: NO_AUTH_REPLY() };
      }
      conn.verified = true;
    } catch (err) {
      if (err instanceof RateLimitedError) return { reply: RATE_LIMITED() };
      return { reply: UPSTREAM_DOWN() };
    }
  }
  const dbId = resolveDb(conn);
  if (!dbId) return { reply: er('CACHEIFY_DB_ID not configured for the selected database index') };
  try {
    const res = await rest(method, dbId, conn.apiKey, urlPath, body);
    return { res };
  } catch (err) {
    if (err instanceof RateLimitedError) return { reply: RATE_LIMITED() };
    return { reply: UPSTREAM_DOWN() };
  }
}

/** Resolve the public database id for the connection's SELECT index. */
function resolveDb(conn) {
  if (conn.selectedIndex === 0) return config.dbId || null;
  return dbRegistry.get(conn.selectedIndex) || null;
}

/** Pass-through decoding of REST results into typed replies. */
function decodeValue(value) {
  if (value === null || value === undefined) return nil();
  if (typeof value === 'number') return int(value);
  if (typeof value === 'string') return value === 'OK' ? STATUS_OK : bulk(value);
  if (Array.isArray(value)) return arr(value.map(decodeValue));
  if (typeof value === 'object') {
    // Embedded SCAN returns {cursor, keys} — flatten objects into pairs.
    const flat = [];
    for (const [key, val] of Object.entries(value)) {
      flat.push(bulk(String(key)));
      flat.push(val === undefined ? nil() : decodeValue(val));
    }
    return arr(flat);
  }
  return bulk(String(value));
}

function argInt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function badArgCount(name) {
  return er(`wrong number of arguments for '${name.toLowerCase()}' command`);
}

/** Data verbs that run exclusively on /command and stream well as a batch. */
const BATCHABLE = new Set(['GET', 'DEL', 'EXISTS', 'INCR', 'DECR', 'INCRBY', 'DECRBY', 'TTL', 'PTTL', 'STRLEN', 'LLEN', 'SCARD', 'ZCARD']);

async function dataCommand(conn, name, args) {
  const out = await upstream(conn, 'POST', '/command', { command: name, args });
  if (out.reply) return out.reply;
  if (out.res.status !== 200) return errorFromRest(out.res.status, out.res.json);
  const data = out.res.json ? out.res.json.data : null;
  // /command envelopes wrap the Redis reply as {result: <reply>}.
  const value = data && typeof data === 'object' && 'result' in data ? data.result : data;
  return decodeValue(value);
}

/** Opportunistic pipelining: ≥3 consecutive /command-style reads collapse to
    one /pipeline HTTPS round-trip. On batch failure → sequential fallback. */
async function runPipelineBatch(conn, commands) {
  const body = { commands: commands.map((cmd) => ({ command: cmd.name, args: cmd.args })) };
  const out = await upstream(conn, 'POST', '/pipeline', body);
  if (out.reply) return commands.map(() => out.reply);
  if (out.res.status !== 200) return null; // defer to sequential semantics
  const results = out.res.json.data.results.map((item) => decodeValue(item.result));
  return results;
}

/* ------------------------------------------------------------ translators */

function infoBody() {
  return [
    '# Server',
    `redis_version:${REDIS_VERSION}`,
    'redis_mode:standalone',
    'os:Cacheify RESP gateway',
    `gateway_process_pid:${process.pid}`,
    `uptime_seconds:${Math.floor(process.uptime())}`,
    '# Clients',
    `connected_clients:${sockets.size}`,
    '# Cacheify',
    `cacheify_api:${config.baseUrl}`,
    `cacheify_db:${config.dbId ? 'configured' : 'registry/multi-db'}`,
    '# Keyspace',
    `expiration:false-mandatory-policy`,
  ].join('\r\n');
}

function helloPairs(proto, id) {
  return [
    [bulk('server'), bulk('redis')],
    [bulk('version'), bulk(REDIS_VERSION)],
    [bulk('proto'), int(proto)],
    [bulk('id'), int(id)],
    [bulk('mode'), bulk('standalone')],
    [bulk('role'), bulk('master')],
    [bulk('modules'), arr([])],
  ];
}

function sendHelloReply(conn, proto) {
  const pairs = helloPairs(proto, Math.floor(Math.random() * 1e6));
  return proto >= 3 ? mapReply(pairs) : arr(pairs.flat());
}

/**
 * HELLO [protover [AUTH user pass] [SETNAME name]]
 * Negotiates RESP3; authenticates inline for clients that piggyback a key.
 */
async function translateHello(conn, args) {
  let proto = conn.proto;
  let index = 0;
  if (args.length > 0 && /^[0-9]+$/.test(args[0])) {
    if (args[0] !== '2' && args[0] !== '3') return er('NOPROTO unsupported protocol version');
    proto = Number(args[0]);
    index = 1;
  }
  let authUsername = null;
  let authPassword = null;
  while (index < args.length) {
    const sub = args[index].toUpperCase();
    if (sub === 'AUTH') {
      if (args.length < index + 3) {
        return er("syntax error in HELLO options: expected 'AUTH username password'");
      }
      authUsername = args[index + 1];
      authPassword = args[index + 2];
      index += 3;
    } else if (sub === 'SETNAME') {
      if (args.length < index + 2) {
        return er("syntax error in HELLO options: expected 'SETNAME name'");
      }
      index += 2;
    } else {
      return er("syntax error in HELLO options: expected 'AUTH username password' or 'SETNAME name'");
    }
  }
  if (authUsername !== null) {
    const reply = authUserPass(conn, authUsername, authPassword);
    if (reply.t === 'error') return reply; // wrong username/password shape etc.
    // Hello-AUTH verifies eagerly so the client gets a definitive failure here.
    const dbId = resolveDb(conn);
    if (!dbId) return er('CACHEIFY_DB_ID not configured for the selected database index');
    try {
      const res = await rest('POST', dbId, conn.apiKey, '/command', { command: 'GET', args: [PROBE_KEY] });
      if (res.status !== 200) {
        conn.bad = true;
        conn.closeAfterReply = true;
        return er('WRONGPASS invalid username-password pair or user is disabled.');
      }
      conn.verified = true;
    } catch (err) {
      if (err instanceof RateLimitedError) return RATE_LIMITED();
      return UPSTREAM_DOWN();
    }
  }
  conn.proto = proto; // replies (incl. this one) emit at the negotiated level
  return sendHelloReply(conn, proto);
}

/**
 * AUTH [username] password — the password CARRIES the rk_ API key.
 * Verified lazily: accepted here, proven on the first data command.
 */
function authUserPass(conn, username, password) {
  if (username !== 'default') {
    conn.bad = true;
    conn.closeAfterReply = true;
    return er('WRONGPASS invalid username-password pair or user is disabled.');
  }
  const accepted = config.bypassAuth
    ? (password.startsWith('rk_') || !password) // container: env key rules
    : password.startsWith('rk_');
  if (!accepted) {
    conn.bad = true;
    conn.closeAfterReply = true;
    return er('WRONGPASS invalid username-password pair or user is disabled.');
  }
  if (password.startsWith('rk_')) {
    conn.apiKey = password;
    conn.verified = false;
  } else {
    warn(`connection: AUTH password ignored in bypass mode (using CACHEIFY_API_KEY)`);
  }
  conn.bad = false;
  conn.closeAfterReply = false;
  return STATUS_OK;
}

async function translateSet(conn, args) {
  if (args.length < 2) return badArgCount('SET');
  let expiresInMs = null;
  let commandModifier = false;
  for (let i = 2; i < args.length; i += 1) {
    const token = args[i].toUpperCase();
    if (token === 'EX' || token === 'PX') {
      if (i + 1 >= args.length) return badArgCount('SET');
      const amount = argInt(args[i + 1]);
      if (amount === null || amount <= 0) return er(`invalid expire time in 'set' command`);
      expiresInMs = token === 'EX' ? amount * 1000 : amount;
      i += 1;
      // Anything else (NX, XX, KEEPTTL, EXAT, PXAT, GET, garbage) → the
      // command plane keeps the bytes verbatim and answers exactly like Redis.
    } else {
      commandModifier = true;
      break;
    }
  }
  if (commandModifier) return dataCommand(conn, 'SET', args);
  const out = await upstream(conn, 'PUT', `/strings/${encodeURIComponent(String(args[0]))}`, {
    value: args[1],
    ...(expiresInMs !== null ? { expiresInMs } : {}),
  });
  if (out.reply) return out.reply;
  if (out.res.status !== 200 && out.res.status !== 201) return errorFromRest(out.res.status, out.res.json);
  return STATUS_OK;
}

async function translateSetEx(conn, name, args) {
  if (args.length !== 3) return badArgCount(name);
  const amount = argInt(args[1]);
  if (amount === null || amount <= 0) return er(`invalid expire time in '${name.toLowerCase()}' command`);
  const out = await upstream(conn, 'PUT', `/strings/${encodeURIComponent(String(args[0]))}`, {
    value: args[2],
    expiresInMs: name === 'SETEX' ? amount * 1000 : amount,
  });
  if (out.reply) return out.reply;
  if (out.res.status !== 200 && out.res.status !== 201) return errorFromRest(out.res.status, out.res.json);
  return STATUS_OK;
}

async function translateExpire(conn, name, args) {
  if (args.length !== 2) return badArgCount(name);
  const amount = argInt(args[1]);
  if (amount === null || amount <= 0) return er(`invalid expire time in '${name.toLowerCase()}' command`);
  const out = await upstream(conn, 'POST',
    `/keys/${encodeURIComponent(String(args[0]))}/expire`,
    { expiresInMs: name === 'EXPIRE' ? amount * 1000 : amount });
  if (out.reply) return out.reply;
  if (out.res.status === 200 || out.res.status === 201) {
    // REST envelope is {applied: bool}: 1 when the key exists and the TTL
    // was armed, 0 for a missing key (Redis answers 0, not an error).
    const data = out.res.json ? out.res.json.data : null;
    const applied = data && typeof data === 'object' && 'applied' in data ? data.applied : data;
    return int(applied ? 1 : 0);
  }
  if (out.res.status === 404) return int(0); // missing key answers 0, not an error
  return errorFromRest(out.res.status, out.res.json);
}

/** One command through the local/remote translation table. */
async function translate(conn, cmd) {
  const { name, args } = cmd;
  switch (name) {
    case 'PING':
      if (args.length > 1) return badArgCount('PING');
      return args.length === 1 ? bulk(args[0]) : st('PONG');

    case 'ECHO':
      if (args.length !== 1) return badArgCount('ECHO');
      return bulk(args[0]);

    case 'QUIT':
      conn.closeAfterReply = true;
      return STATUS_OK;

    case 'AUTH':
      if (args.length === 1) return authUserPass(conn, 'default', args[0]);
      if (args.length === 2) return authUserPass(conn, args[0], args[1]);
      return badArgCount('AUTH');

    case 'HELLO':
      return translateHello(conn, args);

    case 'SELECT': {
      if (args.length !== 1) return badArgCount('SELECT');
      const idx = argInt(args[0]);
      if (idx === null || idx < 0) return er('DB index is out of range');
      if (idx !== 0 && !dbRegistry.has(idx)) return er('DB index is out of range');
      conn.selectedIndex = idx;
      return STATUS_OK;
    }

    case 'INFO':
      return bulk(infoBody());

    case 'CLIENT': {
      if (args.length === 0) return er("unknown subcommand or wrong number of arguments for 'CLIENT'");
      const sub = args[0].toUpperCase();
      if (sub === 'SETINFO' || sub === 'SETNAME' || sub === 'NO-EVICT' || sub === 'NO-TOUCH') return STATUS_OK;
      if (sub === 'ID') return int(conn.id);
      if (sub === 'GETNAME') return nil();
      if (sub === 'LIST') return bulk(`id=${conn.id} addr=gateway`);
      return er("unknown subcommand or wrong number of arguments for 'CLIENT'");
    }

    case 'CONFIG': {
      if (args.length === 0) return er("unknown subcommand or wrong number of arguments for 'CONFIG'");
      const sub = args[0].toUpperCase();
      if (sub === 'GET') {
        const flat = [];
        for (const param of args.slice(1)) {
          flat.push(bulk(String(param)));
          flat.push(bulk(''));
        }
        return arr(flat);
      }
      if (sub === 'SET' || sub === 'RESETSTAT' || sub === 'REWRITE') return STATUS_OK;
      return er("unknown subcommand or wrong number of arguments for 'CONFIG'");
    }

    case 'COMMAND': {
      if ((args[0] || '').toUpperCase() === 'COUNT') return int(20);
      return arr([]); // COMMAND / DOCS / INFO: clients tolerate an empty map
    }

    case 'SET':
      return translateSet(conn, args);

    case 'SETEX':
    case 'PSETEX':
      return translateSetEx(conn, name, args);

    case 'EXPIRE':
    case 'PEXPIRE':
      return translateExpire(conn, name, args);

    default:
      return dataCommand(conn, name, args);
  }
}

/* --------------------------------------------------------------- transport */

const sockets = new Set();

function makeState() {
  return { buffer: Buffer.alloc(0) };
}

function createConnection(socket) {
  const conn = {
    id: sockets.size,
    proto: 2,
    apiKey: config.bypassAuth && config.apiKey ? config.apiKey : null,
    verified: false,
    bad: false,
    selectedIndex: 0,
    closeAfterReply: false,
    closed: false,
    state: makeState(),
    queue: [],
    pumping: false,

    writeReply(reply) {
      if (reply && typeof reply.then === 'function') {
        reply.then((resolved) => this.writeReply(resolved)).catch((err) => {
          warn(`connection ${this.id} async reply failure: ${err && err.message}`);
          this.writeReply(er('ERR gateway internal error'));
        });
        return;
      }
      if (this.closed) return;
      socket.write(encode(reply, this.proto));
    },

    enqueue(commands) {
      if (this.closed) return;
      if (this.queue.length + commands.length > config.maxQueue) {
        warn(`connection overflow: queue ${this.queue.length}+${commands.length}`);
        socket.write(encode(er('RATE_LIMITED command pipeline too deep, close and retry'), this.proto));
        socket.end();
        this.closed = true;
        return;
      }
      this.queue.push(...commands);
      this.pump().catch((err) => {
        warn(`connection pump failure: ${err && err.stack ? err.stack.split('\n')[0] : err}`);
        if (!this.closed) {
          this.closed = true;
          socket.destroy();
          sockets.delete(conn);
        }
      });
    },

    async pump() {
      if (this.pumping) return;
      this.pumping = true;
      try {
        while (this.queue.length > 0 && !this.closed) {
          const commands = this.queue;
          this.queue = [];
          await processCommands(this, commands);
        }
        if (this.closeAfterReply && !this.closed) {
          this.closed = true;
          socket.end();
          sockets.delete(conn);
        }
      } finally {
        this.pumping = false;
      }
    },

    onData(chunk) {
      if (this.closed) return;
      this.state.buffer = this.state.buffer.length === 0
        ? chunk
        : Buffer.concat([this.state.buffer, chunk]);
      let commands;
      try {
        commands = parseCommands(this.state);
      } catch (err) {
        warn(`protocol error: ${err.message}`);
        this.writeReply(er(`Protocol error: ${err.message}`));
        this.closed = true;
        socket.end();
        sockets.delete(conn);
        return;
      }
      if (commands.length > 0) this.enqueue(commands);
    },
  };

  sockets.add(conn);
  socket.setTimeout(config.idleTimeoutMs, () => {
    warn(`idle timeout, closing connection`);
    socket.end();
  });
  socket.on('data', (chunk) => conn.onData(chunk));
  socket.on('error', (err) => {
    warn(`socket error: ${err.message}`);
    sockets.delete(conn);
  });
  socket.on('close', () => {
    sockets.delete(conn);
    conn.closed = true;
  });
  conn.id = nextConnId++;
  return conn;
}
let nextConnId = 0;

/** Reply pump for one drained batch: regroups batchable reads, else one-by-one. */
async function processCommands(conn, commands) {
  let index = 0;
  while (index < commands.length) {
    const cmd = commands[index];
    if (conn.bad) {
      conn.writeReply(NO_AUTH_REPLY());
      index += 1;
      continue;
    }
    if (BATCHABLE.has(cmd.name)) {
      let end = index;
      while (end < commands.length && BATCHABLE.has(commands[end].name)) end += 1;
      const batch = commands.slice(index, end);
      if (batch.length >= 3) {
        const replies = await runPipelineBatch(conn, batch);
        if (replies && replies.length === batch.length) {
          for (const reply of replies) conn.writeReply(reply);
          index = end;
          continue;
        }
        for (const item of batch) {
          conn.writeReply(await dataCommand(conn, item.name, item.args));
          if (conn.bad) break;
        }
        index = end;
        continue;
      }
      conn.writeReply(await dataCommand(conn, cmd.name, cmd.args));
      index += 1;
      continue;
    }
    const reply = await translate(conn, cmd);
    conn.writeReply(reply);
    index += 1;
    if (conn.closeAfterReply) {
      // Anything queued after QUIT gets one error reply each.
      for (; index < commands.length; index += 1) conn.writeReply(er('connection closing'));
      break;
    }
  }
}

/* -------------------------------------------------------------- bootstrap */

function validateConfig() {
  if (!config.bypassAuth && !config.apiKey && dbRegistry.size === 0) {
    warn('edge mode: connections must AUTH with an rk_ key (passwords map to Bearer ids)');
  }
  if (config.host === '0.0.0.0' && !(config.tlsCert && config.tlsKey)) {
    warn('listening on 0.0.0.0 WITHOUT TLS: GATEWAY_TLS_CERT/KEY for rediss:// or keep loopback');
  }
  if (!config.bypassAuth && config.apiKey) {
    warn('CACHEIFY_API_KEY set but bypass off; container users: GATEWAY_BYPASS_AUTH=1');
  }
}

function startServer() {
  validateConfig();
  const options = { highWaterMark: 64 * 1024 };
  let server;
  if (config.tlsCert && config.tlsKey) {
    server = tls.createServer({
      ...options,
      cert: require('fs').readFileSync(config.tlsCert),
      key: require('fs').readFileSync(config.tlsKey),
      minVersion: 'TLSv1.2',
    }, createConnection);
  } else {
    server = net.createServer(options, createConnection);
  }
  server.maxConnections = config.maxConnections;

  server.listen(config.port, config.host, () => {
    const scheme = config.tlsCert && config.tlsKey ? 'rediss' : 'redis';
    const address = server.address();
    log(`listening scheme=${scheme} host=${config.host} port=${address.port} api=${config.baseUrl}`);
    log(`registry=${[...dbRegistry.entries()].map(([idx, db]) => `${idx}→${db.slice(0, 8)}…`).join(' ') || 'AUTH-keys-only'}`);
  });
  server.on('error', (err) => {
    log(`server error: ${err.message}`);
    process.exitCode = 1;
  });

  const shutdown = (signal) => {
    log(`${signal}: draining ${sockets.size} connection(s)`);
    for (const connection of sockets) {
      connection.closed = true;
      try { connection.socket.end(); } catch { /* ignore */ }
    }
    sockets.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    warn(`uncaught: ${err.stack || err}`);
  });
  return server;
}

/* Direct run = server. Require() = library (test/integration harness). */
if (require.main === module) {
  startServer();
}

module.exports = {
  config,
  dbRegistry,
  encode,
  parseCommands,
  translate,
  errorFromRest,
  startServer,
  st, er, int, bulk, arr, nil, mapReply,
};
