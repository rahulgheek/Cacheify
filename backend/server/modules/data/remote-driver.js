'use strict';

/**
 * Remote Redis driver: data plane against a real Redis server via ioredis.
 *
 * Each hosted database maps to an isolated key-prefix namespace on the shared
 * server:  `<keyPrefix><namespace>:<key>`  (default prefix "rh:").
 *
 * The same command registry surface as the embedded engine is honored; per-
 * command key-argument positions are rewritten at the boundary, KEYS/SCAN
 * patterns are prefixed and their results stripped, and FLUSHDB is re-implemented
 * over SCAN so it can never touch another tenant's keys. TTL expiry, atomicity
 * and deletions are native Redis semantics; no platform data is stored there.
 */

const Redis = require('ioredis');
const fs = require('node:fs');
const { config } = require('../../core/env');
const { info, warn } = require('../../core/logger');
const errors = require('../../core/errors');
const { EngineError, validateRegistryCommand } = require('./engine');
const phaseTimer = require('../../core/phase-timer');

const PREFIX = config.redis.keyPrefix;
const SCAN_CHUNK = 500;
const SCAN_MATCH_PAGES = 50; // bounded effort per browse/quota request
const UNLINK_BATCH = 256;

let client = null;
let unlinkSupported = true;
let connectLoggedOnce = false;

/* TLS trust for the remote connection. Only the provider's CA bundle is added
   when configured; certificate and hostname verification remain enabled and
   are never bypassed. Scheme-less `redis://` URIs are upgraded to TLS when a
   CA file is present or the provider requires it (use `rediss://` to force). */
function tlsOptions() {
  if (!config.redis.tlsCaFile) return undefined;
  try {
    return { ca: fs.readFileSync(config.redis.tlsCaFile, 'utf8') };
  } catch (err) {
    throw new errors.AppError(
      500,
      'ERR_CONFIG',
      `REDIS_TLS_CA_FILE is unreadable: ${err.message}`,
    );
  }
}

/* Key argument positions (0-based into args) for the registry surface. */
const SINGLE_KEY_COMMANDS = new Set([
  'GET', 'SET', 'SETEX', 'PSETEX', 'INCR', 'DECR', 'INCRBY', 'DECRBY',
  'APPEND', 'STRLEN', 'GETRANGE', 'TYPE', 'EXPIRE', 'PEXPIRE', 'TTL', 'PTTL',
  'PERSIST', 'EXPIRETIME', 'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LRANGE', 'LLEN',
  'LINDEX', 'LSET', 'LTRIM', 'LREM', 'SADD', 'SREM', 'SISMEMBER', 'SMEMBERS',
  'SCARD', 'HSET', 'HGET', 'HGETALL', 'HDEL', 'HKEYS', 'HVALS', 'HLEN',
  'HEXISTS', 'ZADD', 'ZSCORE', 'ZCARD', 'ZREM', 'ZRANGE',
]);

/* Commands whose args are ALL keys (first through last). */
const ALL_KEY_COMMANDS = new Set(['MGET', 'EXISTS', 'DEL', 'SINTER', 'SUNION', 'SDIFF']);

/** Safe connection summary for logs (scheme/host/port/db, never credentials). */
function safeTarget() {
  try {
    const url = new URL(config.redis.connectionString);
    return `${url.protocol}//${url.hostname}:${url.port || '(default)'}${url.pathname}`;
  } catch (_err) {
    return '<unparsed-connection-target>';
  }
}

function getClient() {
  if (client) return client;
  const options = {
    maxRetriesPerRequest: 2,
    // Tight scheduling: a degraded provider must turn into a fast 503
    // envelope, never a >10s held connection (the OLD 10s command budget was
    // exactly what surfaced as client SocketTimeoutException read timeouts).
    connectTimeout: 5_000,
    commandTimeout: 5_000,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
    // Restricted provider users (e.g. botkeep) lack INFO permission, so the
    // ready check always logs NOPERM and adds ~1s to connect. Plain roundtrip
    // probing is done separately by the app's reachability check.
    enableReadyCheck: false,
  };
  const tls = tlsOptions();
  let uri = config.redis.connectionString;
  if (tls) {
    options.tls = tls;
    // Providers that require TLS reject plain-redis handshakes; upgrade the
    // scheme so certificate verification applies (rediss => TLS + verify).
    if (/^redis:\/\//i.test(uri)) {
      uri = uri.replace(/^redis:\/\//i, 'rediss://');
      info('redis_tls_upgraded', { reason: 'REDIS_TLS_CA_FILE configured' });
    }
  }
  client = new Redis(uri, options);
  client.on('error', (err) => {
    warn('redis_remote_error', { target: safeTarget(), error: err.message });
  });
  if (!connectLoggedOnce) {
    connectLoggedOnce = true;
    info('redis_remote_connecting', { target: safeTarget() });
  }
  return client;
}

function fullKey(namespace, name) {
  return `${PREFIX}${namespace}:${name}`;
}

function fullPattern(namespace, pattern) {
  return `${PREFIX}${namespace}:${String(pattern)}`;
}

/** Strip the namespace prefix from a Redis-returned key. */
function stripKey(namespace, key) {
  return String(key).slice(PREFIX.length + namespace.length + 1);
}

/** Positions in `args` that hold key names (MSET uses even/odd key/value pairs). */
function keyPositions(command, args) {
  if (command === 'MSET') {
    const positions = [];
    for (let i = 0; i + 1 < args.length; i += 2) positions.push(i);
    return positions;
  }
  if (command === 'RENAME') return [0, 1]; // source and destination keys
  if (ALL_KEY_COMMANDS.has(command)) {
    return args.map((_arg, index) => index);
  }
  if (SINGLE_KEY_COMMANDS.has(command) && args.length > 0) return [0];
  return [];
}

/** Rewrite key args + embedded patterns for the wire; returns nothing in-place free copy. */
function remapArgs(namespace, command, args) {
  const out = args.map((arg) => String(arg));
  for (const position of keyPositions(command, out)) {
    out[position] = fullKey(namespace, out[position]);
  }
  if (command === 'SCAN') {
    for (let i = 0; i + 1 < out.length; i += 1) {
      if (out[i].toUpperCase() === 'MATCH') out[i + 1] = fullPattern(namespace, out[i + 1]);
    }
  }
  return out;
}

/**
 * Run one command on the remote server, converting Redis reply errors into
 * domain errors (422) and transport/connection failures into 503.
 */
async function runCommand(redis, cmd, ...args) {
  const redisStart = performance.now();
  try {
    return await redis.call(cmd, ...args);
  } catch (err) {
    if (err && err.name === 'ReplyError') throw new EngineError(err.message);
    throw new errors.ServiceUnavailableError(`Redis temporary failure: ${err.message}`);
  } finally {
    phaseTimer.track('redis', performance.now() - redisStart);
  }
}

/** Fold a RESP2 hash reply (nested or flat pair array) into an object. */
function foldHashReply(reply) {
  if (Array.isArray(reply)) {
    const flat = reply.flatMap((item) => (Array.isArray(item) ? item : [item]));
    const object = {};
    for (let i = 0; i + 1 < flat.length; i += 2) object[flat[i]] = flat[i + 1];
    return object;
  }
  return reply || {};
}

/* The embedded engine returns pair-array replies flattened ([member, score,
   member, score]); fold ioredis's nested pair arrays back into that shape. */
function flattenPairReply(reply) {
  if (Array.isArray(reply) && reply.some(Array.isArray)) {
    return reply.flatMap((item) => (Array.isArray(item) ? item : [item]));
  }
  return reply;
}

/** Normalize a raw ioredis `.call()` reply into embedded-engine shapes. */
function shapeReply(command, reply) {
  if (command === 'HGETALL') return foldHashReply(reply);
  return flattenPairReply(reply);
}

/**
 * Execute one validated registry command on the remote server with namespace
 * isolation. Read/write replies are returned roughly as ioredis decodes them
 * (strings/numbers/arrays/objects), matching the embedded engine's shapes.
 */
async function execute(namespace, command, args) {
  const cmd = String(command).toUpperCase();
  const redis = getClient();

  if (cmd === 'KEYS') {
    const keys = await runCommand(redis, 'KEYS', fullPattern(namespace, args[0]));
    return (keys || []).map((key) => stripKey(namespace, key));
  }
  if (cmd === 'SCAN') {
    const remapped = remapArgs(namespace, cmd, args);
    const reply = await runCommand(redis, 'SCAN', ...remapped);
    const [cursor, keys] = reply;
    return [Number(cursor), (keys || []).map((key) => stripKey(namespace, key))];
  }
  if (cmd === 'FLUSHDB') {
    countCache.delete(namespace);
    await deleteNamespace(namespace);
    return 'OK';
  }
  if (cmd === 'SWEEP') {
    return 0; // expiry is native on the real server; nothing to sweep
  }

  const result = await runCommand(redis, cmd, ...remapArgs(namespace, cmd, args));
  if (result instanceof Error) throw new EngineError(result.message);
  return shapeReply(cmd, result);
}

/** Ping the remote server; returns basic health info (no data leakage). */
async function ping() {
  const startedAt = Date.now();
  await getClient().ping();
  return { ok: true, latencyMs: Date.now() - startedAt };
}

/** Close the shared connection (graceful shutdown). */
async function close() {
  if (client) {
    const closing = client;
    client = null;
    connectLoggedOnce = false;
    unlinkSupported = true;
    try {
      await closing.quit();
    } catch (_err) {
      closing.disconnect();
    }
  }
}

/** EXIST count for explicit key names (used for incremental quota checks).
    Returns one 0/1 flag per name (Redis semantics for multi-key EXISTS). */
async function existsKeys(namespace, names) {
  if (names.length === 0) return [];
  const redis = getClient();
  const reply = await runCommand(redis, 'EXISTS', ...names.map((name) => fullKey(namespace, name)));
  return names.length === 1 ? [reply] : reply;
}

/** Mandatory-expiry policy helper: stamp the default TTL on freshly created
    key names (no-op for names whose PEXPIRE finds nothing to expire). */
async function stampDefaultTtl(namespace, names) {
  const redis = getClient();
  for (const name of names) {
    await runCommand(redis, 'PEXPIRE', fullKey(namespace, name), String(config.defaultKeyTtlMs));
  }
}

/**
 * Iterate one namespace until `stopAfter` matched keys (bounded pages); a
 * "cap" stop means the real total is at least that large, which is all quota
 * enforcement needs. Returns { cursor, count }.
 */
async function scanNamespace(redis, pattern, stopAfter) {
  let cursor = '0';
  let count = 0;
  for (let page = 0; page < SCAN_MATCH_PAGES; page += 1) {
    const reply = await runCommand(redis, 'SCAN', cursor, 'MATCH', pattern, 'COUNT', SCAN_CHUNK);
    cursor = String(reply[0]);
    count += reply[1].length;
    if (Number.isFinite(stopAfter) && count >= stopAfter) break;
    if (cursor === '0') break;
  }
  return { cursor, count };
}

/**
 * Approximate key count for a namespace, stopping early at `stopAfter`.
 * Good enough for quota enforcement: any count >= cap is already over quota.
 */
async function countNamespace(namespace, stopAfter = Number.MAX_SAFE_INTEGER) {
  const redis = getClient();
  const { count } = await scanNamespace(redis, fullPattern(namespace, '*'), stopAfter);
  return count;
}

/* Cached approximate key counts per namespace. The first creating write after
   a cache miss pays one bounded scan; every subsequent write inside the TTL
   window reuses the cached number and increments it conservatively (never
   undercounts during a burst), so plan limits stay enforced at a fraction of
   the per-write cost. Expiry makes counts drift downwards-only; renames and
   deletes reconcile on the next recalculation. */
const countCache = new Map(); // namespace -> { value, expiresAt, inflight }

/** Undercounts are only possible after key expiry; overcounting is the safe
    direction for plan limits, so drift never weakens enforcement. */
async function cachedNamespaceCount(namespace, stopAfter) {
  const now = Date.now();
  const cached = countCache.get(namespace);
  if (cached && cached.inflight && now < cached.expiresAt + 60_000) return cached.inflight;
  if (cached && now < cached.expiresAt) return cached.value;
  const inflight = countNamespace(namespace, stopAfter)
    .then((count) => {
      countCache.set(namespace, {
        value: count,
        expiresAt: Date.now() + config.quotaCountTtlMs,
        inflight: null,
      });
      return count;
    })
    .catch((err) => {
      countCache.delete(namespace);
      throw err;
    });
  countCache.set(namespace, { ...(cached || { value: 0, expiresAt: 0 }), inflight });
  return inflight;
}

/** Track writes that may create keys; keeps the cached count conservative. */
function bumpNamespaceCount(namespace, delta) {
  if (delta <= 0) return;
  const cached = countCache.get(namespace);
  if (cached) cached.value += delta;
}

/** Delete every key inside one namespace (SCAN + UNLINK, DEL fallback). */
async function deleteNamespace(namespace) {
  const redis = getClient();
  const pattern = fullPattern(namespace, '*');
  let cursor = '0';
  do {
    const reply = await runCommand(redis, 'SCAN', cursor, 'MATCH', pattern, 'COUNT', SCAN_CHUNK);
    cursor = String(reply[0]);
    const batch = reply[1];
    if (batch.length > 0) {
      for (let i = 0; i < batch.length; i += UNLINK_BATCH) {
        const chunk = batch.slice(i, i + UNLINK_BATCH);
        if (unlinkSupported) {
          try {
            await runCommand(redis, 'UNLINK', ...chunk);
          } catch (err) {
            if (err && err.name === 'EngineError' && /unknown command/i.test(err.message)) {
              unlinkSupported = false;
              await runCommand(redis, 'DEL', ...chunk);
            } else {
              throw err;
            }
          }
        } else {
          await runCommand(redis, 'DEL', ...chunk);
        }
      }
    }
  } while (cursor !== '0');
}

/**
 * Remote quota preflight for one write command:
 *  - reject any single argument larger than the value cap (cheap, deterministic)
 *  - exact byte estimate for string overwrites (value arg length; APPEND reads STRLEN)
 *  - incremental key-count quota via EXISTS + bounded namespace count
 *  - returns the names the command would create (for mandatory-expiry stamping)
 */
async function preflightQuotas(namespace, ownerQuota, command, args) {
  const cmd = String(command).toUpperCase();
  const { maxKeysPerDb, maxValueBytes } = ownerQuota;

  // 1) Value-size preflight.
  const valueBytes = await estimateNewKeyBytes(namespace, cmd, args);
  if (valueBytes > maxValueBytes) {
    throw new errors.QuotaExceededError(
      `Plan limit reached: values up to ${maxValueBytes} bytes`,
      [{ field: 'quota', issue: 'maxValueBytes' }],
    );
  }

  // 2) Key-count preflight for commands that may create keys.
  const affected = affectedKeyNames(cmd, args);
  if (affected.length === 0) return { createdNames: [] };
  const existingFlags = await existsKeys(namespace, affected);
  const createdNames = affected.filter((_name, i) => existingFlags[i] !== 1);
  if (createdNames.length === 0) return { createdNames: [] };
  const total = await cachedNamespaceCount(namespace, maxKeysPerDb);
  if (total + createdNames.length > maxKeysPerDb) {
    throw new errors.QuotaExceededError(
      `Plan limit reached: at most ${maxKeysPerDb} keys per database`,
      [{ field: 'quota', issue: 'maxKeysPerDb' }],
    );
  }
  // Optimistic bump: the write below may still fail, which overcounts the
  // cache slightly - the safe direction for plan limits (reconciled by TTL).
  bumpNamespaceCount(namespace, createdNames.length);
  return { createdNames };
}

/** Commands whose first execution may create keys (mirrors service logic). */
const CREATING_COMMANDS = new Set([
  'SET', 'SETEX', 'PSETEX', 'MSET', 'LPUSH', 'RPUSH', 'SADD', 'HSET', 'ZADD',
  'INCR', 'DECR', 'INCRBY', 'DECRBY', 'APPEND',
]);

function affectedKeyNames(command, args) {
  if (command === 'MSET') {
    const names = [];
    for (let i = 0; i + 1 < args.length; i += 2) names.push(String(args[i]));
    return names;
  }
  if (CREATING_COMMANDS.has(command) && args.length > 0) return [String(args[0])];
  return [];
}

/**
 * Exact/approximate size the write will occupy, before it happens.
 * String overwrites: length of the incoming value (deterministic).
 * APPEND: existing STRLEN + incoming bytes. Collections: max(0, incoming arg bytes).
 */
async function estimateNewKeyBytes(namespace, command, args) {
  let worst = 0;
  const strArgs = args.map((a) => String(a));

  if (command === 'SET' && strArgs.length >= 2) {
    worst = Buffer.byteLength(strArgs[1], 'utf8');
  } else if ((command === 'SETEX' || command === 'PSETEX') && strArgs.length >= 3) {
    worst = Buffer.byteLength(strArgs[2], 'utf8');
  } else if (command === 'MSET') {
    for (let i = 1; i + 1 < strArgs.length; i += 2) {
      worst = Math.max(worst, Buffer.byteLength(strArgs[i], 'utf8'));
    }
  } else if (command === 'APPEND') {
    const redis = getClient();
    const current = await runCommand(redis, 'STRLEN', fullKey(namespace, strArgs[0]));
    worst = existingLen(current) + Buffer.byteLength(strArgs[1] || '', 'utf8');
  } else {
    // Collections/keys: bound-check incoming argument bytes (per-request cap).
    for (const arg of strArgs) {
      worst = Math.max(worst, Buffer.byteLength(arg, 'utf8'));
    }
  }
  return worst;
}

function existingLen(strLenReply) {
  return typeof strLenReply === 'number' && strLenReply > 0 ? strLenReply : 0;
}

/* Native batched pipeline execution (remote mode). Quota preflight stays
   enforced but is batched: one EXISTS per distinct key-creating name, one
   cached count check, value bounds from argument lengths (APPEND's existing
   STRLEN is batched), then every command travels in ONE MULTI/EXEC round
   trip instead of a per-command socket round trip. Providers that reject
   MULTI fall back to sequential execution for the process (same pattern as
   UNLINK support detection). */

let multiSupported = true;

function boundedValueBytes(planned, maxValueBytes) {
  // Synchronous mirror of estimateNewKeyBytes; APPEND uses the batched STRLEN.
  for (const p of planned) {
    const { cmd, argv } = p;
    let worst = 0;
    if (cmd === 'SET' && argv.length >= 2) {
      worst = Buffer.byteLength(argv[1], 'utf8');
    } else if ((cmd === 'SETEX' || cmd === 'PSETEX') && argv.length >= 3) {
      worst = Buffer.byteLength(argv[2], 'utf8');
    } else if (cmd === 'MSET') {
      for (let i = 1; i + 1 < argv.length; i += 2) {
        worst = Math.max(worst, Buffer.byteLength(argv[i], 'utf8'));
      }
    } else if (cmd === 'APPEND' && argv.length >= 2) {
      worst = (p.currentLen || 0) + Buffer.byteLength(argv[1], 'utf8');
    } else {
      for (const arg of argv) worst = Math.max(worst, Buffer.byteLength(arg, 'utf8'));
    }
    if (worst > maxValueBytes) {
      throw new errors.QuotaExceededError(
        `Plan limit reached: values up to ${maxValueBytes} bytes`,
        [{ field: 'quota', issue: 'maxValueBytes' }],
      );
    }
  }
}

async function executePipeline(namespace, ownerQuota, commands) {
  if (!Array.isArray(commands) || commands.length === 0) return [];
  const redis = getClient();
  const { maxKeysPerDb, maxValueBytes } = ownerQuota;

  /* 1) Validate and remap once; collect key-creating names per command. */
  const planned = [];
  const creatingNames = [];
  for (const { command, args } of commands) {
    const cmd = String(command).toUpperCase();
    const argv = (args || []).map((a) => String(a));
    validateRegistryCommand(cmd, argv);
    const affected = affectedKeyNames(cmd, argv);
    creatingNames.push(...affected);
    planned.push({ cmd, argv: remapArgs(namespace, cmd, argv), affected });
  }

  /* 2) Batched value-size preflight (only APPEND needs a remote lookup). */
  const appendEntries = planned.filter((p) => p.cmd === 'APPEND' && p.argv.length >= 2);
  if (appendEntries.length > 0) {
    const lensPipeline = redis.pipeline();
    for (const p of appendEntries) {
      lensPipeline.strlen(fullKey(namespace, p.affected[0]));
    }
    const lensReplies = await lensPipeline.exec().catch((err) => {
      throw new errors.ServiceUnavailableError(`Redis temporary failure: ${err.message}`);
    });
    appendEntries.forEach((p, i) => {
      p.currentLen = existingLen(lensReplies[i] && lensReplies[i][1]);
    });
  }
  boundedValueBytes(planned, maxValueBytes);

  /* 3) Batched key-count preflight across the whole batch, remembering which
        names each command creates (mandatory-expiry stamping). */
  const uniqueCreating = [...new Set(creatingNames)];
  const existsMap = new Map();
  if (uniqueCreating.length > 0) {
    const existingFlags = await existsKeys(namespace, uniqueCreating);
    uniqueCreating.forEach((name, i) => existsMap.set(name, existingFlags[i] === 1));
    const created = uniqueCreating.filter((name) => !existsMap.get(name));
    if (created.length > 0) {
      const total = await cachedNamespaceCount(namespace, maxKeysPerDb);
      if (total + created.length > maxKeysPerDb) {
        throw new errors.QuotaExceededError(
          `Plan limit reached: at most ${maxKeysPerDb} keys per database`,
          [{ field: 'quota', issue: 'maxKeysPerDb' }],
        );
      }
      bumpNamespaceCount(namespace, created.length);
    }
  }
  for (const p of planned) {
    /* SET without EX/PX re-arms the default TTL (plain SET otherwise makes
       the key immortal); commands without expire options stamp PEXPIRE. */
    if (p.cmd === 'SET' && !p.argv.slice(2).some((a) => /^(EX|PX)$/i.test(a))) {
      p.argv = p.argv.concat(['PX', String(config.defaultKeyTtlMs)]);
    }
    p.created = (p.affected || []).filter((name) => existsMap.get(name) === false);
  }

  /* 4) Execute in one atomic MULTI/EXEC; sequential fallback when unsupported.
        Stamp the default TTL right after each creating command (SET carries
        its own PX), and keep the operation index map for result alignment. */
  const ops = [];
  if (multiSupported) {
    const multi = redis.multi();
    for (const p of planned) {
      multi.call(p.cmd, ...p.argv);
      ops.push({ kind: 'cmd', p });
      if (p.cmd !== 'SET') {
        for (const name of p.created) {
          multi.call('PEXPIRE', fullKey(namespace, name), String(config.defaultKeyTtlMs));
          ops.push({ kind: 'ttl', name });
        }
      }
    }
    let replies;
    try {
      replies = await multi.exec();
    } catch (err) {
      if (err && /MULTI|EXEC|NOPERM|unsupported command/i.test(err.message)) {
        multiSupported = false;
      } else {
        throw new errors.ServiceUnavailableError(`Redis temporary failure: ${err.message}`);
      }
    }
    if (replies) {
      const out = new Array(planned.length);
      replies.forEach(([err, reply], opIndex) => {
        const op = ops[opIndex];
        if (op.kind !== 'cmd') return; // TTL stamp reply: best effort
        if (err) throw new EngineError(err.message);
        out[planned.indexOf(op.p)] = shapeReply(op.p.cmd, reply);
      });
      return out;
    }
  }

  /* Fallback: sequential execution (quota already checked as a batch). */
  const out = [];
  for (const p of planned) {
    const reply = await runCommand(redis, p.cmd, ...p.argv);
    if (reply instanceof Error) throw new EngineError(reply.message ?? 'command failed');
    out.push(shapeReply(p.cmd, reply));
    if (p.cmd !== 'SET') {
      for (const name of p.created) {
        await runCommand(redis, 'PEXPIRE', fullKey(namespace, name), String(config.defaultKeyTtlMs));
      }
    }
  }
  return out;
}

/**
 * List a page of key names in the namespace: { name, type, bytes, expiresAt,
 * createdAt, updatedAt }. Cursor-compatible with the embedded id cursor for
 * the client (0 = first page / exhausted).
 */
async function browseKeys(namespace, { pattern, cursor, limit }) {
  const redis = getClient();
  const scanPattern = fullPattern(namespace, pattern || '*');
  let absCursor = String(cursor || '0');
  const names = [];

  for (let page = 0; page < SCAN_MATCH_PAGES; page += 1) {
    const reply = await runCommand(redis, 'SCAN', absCursor, 'MATCH', scanPattern, 'COUNT', SCAN_CHUNK);
    absCursor = String(reply[0]);
    for (const key of reply[1]) {
      names.push(stripKey(namespace, key));
      if (names.length > limit) break;
    }
    if (names.length > limit || absCursor === '0') break;
  }

  const hasMore = names.length > limit;
  const pageNames = names.slice(0, limit).sort();
  const keys = await describeKeys(namespace, pageNames);
  return { keys, meta: { cursor: hasMore && absCursor !== '0' ? Number(absCursor) : 0 } };
}

/** Pipeline TYPE + PTTL + MEMORY USAGE for a batch of key names. */
async function describeKeys(namespace, names) {
  if (names.length === 0) return [];
  const redis = getClient();
  const pipeline = redis.pipeline();
  for (const name of names) {
    const key = fullKey(namespace, name);
    pipeline.type(key);
    pipeline.pttl(key);
    pipeline.memory('USAGE', key);
  }
  const replies = await pipeline.exec()
    .catch((err) => {
      throw new errors.ServiceUnavailableError(`Redis temporary failure: ${err.message}`);
    });
  return names.map((name, index) => {
    const [typeErr, type] = replies[index * 3];
    const [, pttl] = replies[index * 3 + 1];
    const [memoryErr, memory] = replies[index * 3 + 2];
    if (typeErr || !type || type === 'none') return null; // gone between SCAN and read
    const bytes =
      !memoryErr && typeof memory === 'number' && memory > 0 ? memory : null;
    const expiresAt = typeof pttl === 'number' && pttl >= 0
      ? new Date(Date.now() + pttl).toISOString()
      : null;
    return {
      name,
      type: String(type),
      bytes,
      expiresAt,
      createdAt: null,
      updatedAt: null,
    };
  }).filter(Boolean);
}

/**
 * Typed value read + TTL detail for one key. Null when the key does not
 * exist on the remote server (the service throws the 404).
 */
async function getKeyDetail(namespace, name) {
  const redis = getClient();
  const key = fullKey(namespace, name);
  const type = await runCommand(redis, 'TYPE', key);
  if (!type || type === 'none') return null;
  const pttl = await runCommand(redis, 'PTTL', key);
  if (pttl === -2) return null; // expired between reads

  let value;
  let bytes = null;
  switch (type) {
    case 'string': {
      value = await runCommand(redis, 'GET', key);
      bytes = value === null ? 0 : Buffer.byteLength(value, 'utf8');
      break;
    }
    case 'list': {
      value = await runCommand(redis, 'LRANGE', key, 0, -1);
      break;
    }
    case 'set': {
      const members = await runCommand(redis, 'SMEMBERS', key);
      value = [...members].sort();
      break;
    }
    case 'hash': {
      value = foldHashReply(await runCommand(redis, 'HGETALL', key));
      break;
    }
    case 'zset': {
      // RESP2 flat [member, score, member, score] — normalize like the engine.
      const flat = flattenPairReply(await runCommand(redis, 'ZRANGE', key, 0, -1, 'WITHSCORES'));
      value = [];
      for (let i = 0; i < flat.length; i += 2) {
        value.push({ member: flat[i], score: Number(flat[i + 1]) });
      }
      break;
    }
    default:
      value = null;
  }
  if (bytes === null) {
    // Best-effort size accounting for collection types; unsupported on some
    // managed providers (per-reply error) is treated as unknown.
    try {
      const memory = await runCommand(redis, 'MEMORY', 'USAGE', key);
      bytes = typeof memory === 'number' && memory > 0 ? memory : null;
    } catch (_err) {
      bytes = null;
    }
  }
  return {
    name,
    type,
    value,
    bytes,
    ttlMs: typeof pttl === 'number' && pttl >= 0 ? pttl : null,
    expiresAt: typeof pttl === 'number' && pttl > 0
      ? new Date(Date.now() + pttl).toISOString()
      : null,
  };
}

/** Namespace aggregate stats (bounded); the cached count keeps views cheap. */
async function statsFor(namespace, { maxKeysPerDb = Number.MAX_SAFE_INTEGER } = {}) {
  const totalKeys = await cachedNamespaceCount(namespace, maxKeysPerDb);
  return { totalKeys, totalBytes: null, expiringKeys: null, byType: null };
}

module.exports = {
  execute,
  ping,
  close,
  existsKeys,
  countNamespace,
  cachedNamespaceCount,
  bumpNamespaceCount,
  stampDefaultTtl,
  deleteNamespace,
  preflightQuotas,
  executePipeline,
  browseKeys,
  getKeyDetail,
  statsFor,
};
