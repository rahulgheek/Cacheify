'use strict';

/**
 * Data service: tenant authorization, quota enforcement, command execution
 * and DTO projection. Two backends share the same authorization/quota surface:
 *  - local: the platform's own engine over the MongoDB key store
 *    (`redis_keys` collection; atomic via snapshot/restore on quota failure)
 *  - remote: real Redis server via remote-driver (per-database namespace key
 *    prefixes); native expiry.
 */

const { ObjectId } = require('mongodb');
const { config } = require('../../core/env');
const { toPublicKey } = require('../../core/dto');
const store = require('../../core/store');
const audit = require('../../core/audit');
const { globToRegExp } = require('./engine-core');
const keyStore = require('./key-store');
const errors = require('../../core/errors');
const engine = require('./engine');
const remoteDriver = require('./remote-driver');
const databasesDal = require('../databases/dal');
const phaseTimer = require('../../core/phase-timer');

const IS_REMOTE = config.redis.mode === 'remote';

/* Commands whose first execution may create keys (pre-write quota check). */
const CREATING_COMMANDS = new Set([
  'SET', 'SETEX', 'PSETEX', 'MSET', 'LPUSH', 'RPUSH', 'SADD', 'HSET', 'ZADD',
  'INCR', 'DECR', 'INCRBY', 'DECRBY', 'APPEND',
]);

/**
 * Every mutating command in the registry (server/modules/data/engine.js).
 * Read-only API keys are refused for these before any execution. Reads
 * (GET, LRANGE, SMEMBERS, ZRANGE, TTL, SCAN, ...) are unaffected.
 */
const WRITE_COMMANDS = new Set([
  'SET', 'SETEX', 'PSETEX', 'MSET', 'INCR', 'DECR', 'INCRBY', 'DECRBY', 'APPEND',
  'DEL', 'EXPIRE', 'PEXPIRE', 'PERSIST', 'RENAME', 'FLUSHDB', 'SWEEP',
  'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LSET', 'LTRIM', 'LREM',
  'SADD', 'SREM', 'HSET', 'HDEL', 'ZADD', 'ZREM',
]);

/** API keys scoped to one database get their permission level enforced here. */
function assertDatabaseInScope(dbRecord, user) {
  const scope = user.apiKeyScope;
  if (!scope || scope.databasePublicId === null) return;
  if (dbRecord.public_id !== scope.databasePublicId) {
    // Same answer as cross-tenant access: 404, never confirming existence.
    throw new errors.NotFoundError('Database not found');
  }
}

function requireWritePermission(user) {
  const scope = user.apiKeyScope;
  if (!scope || scope.permission === 'read-write') return;
  throw new errors.ForbiddenError('This API key is read-only');
}

function affectedKeyNames(command, args) {
  if (command === 'MSET') {
    const names = [];
    for (let i = 0; i + 1 < args.length; i += 2) names.push(args[i]);
    return names;
  }
  if (CREATING_COMMANDS.has(command) && args.length > 0) return [args[0]];
  return [];
}

/** Pre-write quota check: only counts keys the command would newly create. */
async function preflightKeyQuota(dbRecord, command, args) {
  const keys = affectedKeyNames(command, args);
  if (keys.length === 0) return;
  const existing = await keyStore.existingNames(dbRecord.id, keys);
  const newCount = keys.filter((key) => !existing.has(key)).length;
  if (newCount === 0) return;
  const total = await keyStore.countLiveKeys(dbRecord.id);
  if (total + newCount > dbRecord.owner.max_keys_per_db) {
    throw new errors.QuotaExceededError(
      `Plan limit reached: at most ${dbRecord.owner.max_keys_per_db} keys per database`,
      [{ field: 'quota', issue: 'maxKeysPerDb' }],
    );
  }
}

/** Post-write size check; the caller restores a snapshot when this throws. */
async function checkValueSizes(dbRecord, keys) {
  for (const key of keys) {
    const bytes = await keyStore.valueBytes(dbRecord.id, key);
    if (bytes > dbRecord.owner.max_value_bytes) {
      throw new errors.QuotaExceededError(
        `Plan limit reached: values up to ${dbRecord.owner.max_value_bytes} bytes`,
        [{ field: 'quota', issue: 'maxValueBytes' }],
      );
    }
  }
}

/** Two serial Mongo finds (database + owner plans) sit on EVERY command
    before the engine runs. A short in-process cache keeps warm commands at
    engine-only trips. Staleness bound: plan changes, suspension, and the
    archived/read-only state lag up to the TTL (30s) — acceptable for the
    data plane; revocation of the calling key is handled by the middleware
    epoch cache, not here. */
const DB_RECORD_CACHE = new Map(); // `${user.id}:${publicId}` → { record, expires }
const DB_RECORD_CACHE_TTL_MS = 30_000;

async function loadAuthorizedDatabase(dbPublicId, user) {
  const hit = DB_RECORD_CACHE.get(`${user.id}:${dbPublicId}`);
  const now = Date.now();
  if (hit && hit.epoch === dbRecordCacheEpoch && hit.expires > now) return hit.record;

  const dbRecord = await databasesDal.findByPublicId(dbPublicId);
  if (!dbRecord) throw new errors.NotFoundError('Database not found');
  if (dbRecord.owner_user_id !== user.id && user.role !== 'admin') {
    throw new errors.NotFoundError('Database not found');
  }
  const users = await store.getUsers();
  const owner = await users.findOne({ _id: dbRecord.owner_user_id });
  if (!owner) throw new errors.NotFoundError('Database not found');
  assertDatabaseInScope(dbRecord, user);
  if (owner.status !== 'active') {
    throw new errors.ForbiddenError('Owner account is suspended');
  }
  const record = {
    id: dbRecord.id,
    public_id: dbRecord.public_id,
    namespace: dbRecord.namespace,
    name: dbRecord.name,
    status: dbRecord.status,
    owner_user_id: dbRecord.owner_user_id,
    owner: {
      max_keys_per_db: owner.max_keys_per_db,
      max_value_bytes: owner.max_value_bytes,
      max_databases: owner.max_databases,
    },
  };
  DB_RECORD_CACHE.set(`${user.id}:${dbPublicId}`, {
    record,
    epoch: dbRecordCacheEpoch,
    expires: now + DB_RECORD_CACHE_TTL_MS,
  });
  if (DB_RECORD_CACHE.size > 1000) {
    for (const [key, entry] of DB_RECORD_CACHE) {
      if (entry.expires <= Date.now()) DB_RECORD_CACHE.delete(key);
    }
  }
  return record;
}

function requireActive(dbRecord) {
  if (dbRecord.status !== 'active') {
    throw new errors.ConflictError('Database is archived and read-only');
  }
}

/** Epoch for the authorized-database cache: a control-plane change (owner
    plan patch, account suspension, database archive/name change) bumps it,
    so the next command re-consults Mongo instead of serving a stale record
    for up to the TTL. Cheap: intentional, rarely fired. */
let dbRecordCacheEpoch = 0;

function bumpDatabaseRecordCacheEpoch() {
  dbRecordCacheEpoch += 1;
  DB_RECORD_CACHE.clear();
}

/* ---------------------------------------------------------------- */
/* Remote-mode execution path                                        */
/* ---------------------------------------------------------------- */

/** Commands that can create keys without any expire option: their freshly
    created names are stamped with the platform default TTL after the write. */
const CREATE_CAPABLE_COMMANDS = new Set([
  'MSET', 'APPEND', 'INCR', 'DECR', 'INCRBY', 'DECRBY',
  'LPUSH', 'RPUSH', 'SADD', 'HSET', 'ZADD',
]);

/** Mandatory-expiry: PERSIST has no business on this platform. */
function rejectPersist(cmd) {
  if (cmd !== 'PERSIST') return;
  throw new errors.ValidationError(
    'PERSIST is disabled: every key on this platform expires. Re-arm a TTL with EXPIRE instead.',
  );
}

async function remoteExecuteOne(dbRecord, cmd, args) {
  rejectPersist(cmd);
  const argv = args.map((a) => String(a));
  engine.validateRegistryCommand(cmd, argv);
  const preflight = await remoteDriver.preflightQuotas(
    dbRecord.namespace,
    {
      maxKeysPerDb: dbRecord.owner.max_keys_per_db,
      maxValueBytes: dbRecord.owner.max_value_bytes,
    },
    cmd,
    argv,
  );
  // SET without EX/PX re-arms the default TTL (no-expiry is never allowed).
  let execArgs = argv;
  if (cmd === 'SET' && !argv.slice(2).some((a) => /^(EX|PX)$/i.test(a))) {
    execArgs = argv.concat(['PX', String(config.defaultKeyTtlMs)]);
  }
  const result = await remoteDriver.execute(dbRecord.namespace, cmd, execArgs);
  if (preflight && preflight.createdNames.length > 0 && CREATE_CAPABLE_COMMANDS.has(cmd)) {
    await remoteDriver.stampDefaultTtl(dbRecord.namespace, preflight.createdNames);
  }
  return result;
}

/* ---------------------------------------------------------------- */

/** Execute one command pre-validating quotas; rolls back embedded writes on violation. */
async function executeCommand(dbPublicId, user, command, args) {
  const dbRecord = await loadAuthorizedDatabase(dbPublicId, user);
  requireActive(dbRecord);
  const cmd = String(command).toUpperCase();
  rejectPersist(cmd);
  if (WRITE_COMMANDS.has(cmd)) requireWritePermission(user);
  const argv = (args || []).map((a) => a);
  if (IS_REMOTE) {
    return remoteExecuteOne(dbRecord, cmd, argv);
  }
  /* Snapshot the affected keys first so a post-write quota violation (or a
     domain error mid-command) restores the exact prior state — the atomicity
     the old transactional store provided, on MongoDB. */
  const isWrite = WRITE_COMMANDS.has(cmd);
  const affected = isWrite ? affectedKeyNames(cmd, argv) : [];
  const snapshot = isWrite ? await keyStore.snapshotKeys(dbRecord.id, affected) : null;
  let result;
  try {
    if (isWrite) await preflightKeyQuota(dbRecord, cmd, argv);
    const engineStart = performance.now();
    result = await engine.executeDatabaseCommand(dbRecord.id, cmd, argv);
    phaseTimer.track('engine', performance.now() - engineStart);
    if (isWrite) await checkValueSizes(dbRecord, affected);
    // Usage tracking must never sit in the command's critical path: the
    // response goes out now, the counter increments a tick later.
    void recordCommandUsage(user.id, cmd);
  } catch (err) {
    if (isWrite) await keyStore.restoreSnapshot(snapshot);
    throw err;
  }
  return result;
}

/** Execute a list of commands sequentially; embedded mode stays atomic. */
async function executePipeline(dbPublicId, user, commands) {
  const dbRecord = await loadAuthorizedDatabase(dbPublicId, user);
  requireActive(dbRecord);
  const normalized = commands.map((item) => ({ ...item, command: String(item.command).toUpperCase() }));
  for (const item of normalized) rejectPersist(item.command);
  const writes = normalized.some((item) => WRITE_COMMANDS.has(item.command));
  if (writes) requireWritePermission(user);
  if (IS_REMOTE) {
    const results = await remoteDriver.executePipeline(
      dbRecord.namespace,
      {
        maxKeysPerDb: dbRecord.owner.max_keys_per_db,
        maxValueBytes: dbRecord.owner.max_value_bytes,
      },
      commands.map((item) => ({ command: item.command, args: (item.args || []).map((a) => String(a)) })),
    );
    return results.map((result, index) => ({
      command: normalized[index].command,
      result,
    }));
  }
  /* Snapshot every affected key up front: pipeline failure (quota or domain)
     restores the exact starting state, preserving all-or-nothing semantics. */
  const affectedAll = normalized.flatMap((item) => affectedKeyNames(item.command, item.args || []));
  const snapshot = await keyStore.snapshotKeys(dbRecord.id, affectedAll);
  try {
    const results = [];
    for (const item of normalized) {
      await preflightKeyQuota(dbRecord, item.command, item.args || []);
      results.push({
        command: item.command,
        result: await engine.executeDatabaseCommand(dbRecord.id, item.command, item.args || []),
      });
    }
    await checkValueSizes(dbRecord, affectedAll);
    for (const item of normalized) {
      void recordCommandUsage(user.id, item.command);
    }
    return results;
  } catch (err) {
    await keyStore.restoreSnapshot(snapshot);
    throw err;
  }
}

/** Compound fixed-window rate limiting on ordinary TTL-armed keys: one INCR
    per rule (creates + stamps the platform default TTL), PEXPIRE arms the
    user's window when the counter starts at 1, PTTL feeds resetMs. */
async function applyRateRules(dbPublicId, user, rules) {
  const out = [];
  for (const [key, limit, windowMs] of rules) {
    const rawCount = await executeCommand(dbPublicId, user, 'INCR', [key]);
    const count = typeof rawCount === 'number' ? rawCount : Number(rawCount);
    if (count === 1) {
      // First hit arms the caller's window (overriding the mandatory default).
      await executeCommand(dbPublicId, user, 'PEXPIRE', [key, String(windowMs)]);
    }
    const rawTtl = await executeCommand(dbPublicId, user, 'PTTL', [key]);
    const ttl = typeof rawTtl === 'number' ? rawTtl : Number(rawTtl);
    out.push({
      key,
      limit,
      windowMs,
      count,
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetMs: Number.isFinite(ttl) && ttl > 0 ? ttl : 0,
    });
  }
  return out;
}

/** Browse keys with cursor pagination + optional glob pattern (bounded queries). */
async function browseKeys(dbPublicId, user, { pattern, cursor, limit }) {
  const dbRecord = await loadAuthorizedDatabase(dbPublicId, user);
  if (IS_REMOTE) {
    return remoteDriver.browseKeys(dbRecord.namespace, { pattern, cursor, limit });
  }
  /* The cursor is a hex ObjectId from the previous page. */
  const afterId = /^[a-f\d]{24}$/i.test(String(cursor)) ? new ObjectId(String(cursor)) : null;
  const { rows } = await keyStore.rowsPage(dbRecord.id, { afterId, limit });
  const matcher = pattern ? globToRegExp(pattern) : null;
  const now = Date.now();

  const keys = [];
  for (const row of rows) {
    if (row.expires_at !== null && row.expires_at <= now) {
      await keyStore.deleteById(dbRecord.id, row.id);
      continue;
    }
    if (matcher && !matcher.test(row.name)) continue;
    keys.push({ ...toPublicKey(row), bytes: Buffer.byteLength(row.value, 'utf8') });
  }

  // A full page means iteration should continue from the last fetched row id.
  const hasMore = rows.length === limit;
  return {
    keys,
    meta: { cursor: hasMore && rows.length > 0 ? String(rows[rows.length - 1].id) : 0 },
  };
}

/** Full key detail with typed value decode. */
async function getKeyDetail(dbPublicId, user, keyName) {
  const dbRecord = await loadAuthorizedDatabase(dbPublicId, user);
  if (IS_REMOTE) {
    const detail = await remoteDriver.getKeyDetail(dbRecord.namespace, keyName);
    if (!detail) throw new errors.NotFoundError('Key not found');
    return {
      name: detail.name,
      type: detail.type,
      expiresAt: detail.expiresAt,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      bytes: detail.bytes,
      ttlMs: detail.ttlMs,
      value: detail.value,
    };
  }
  const storeStart = performance.now();
  const row = await keyStore.liveRow(dbRecord.id, keyName);
  phaseTimer.track('engine', performance.now() - storeStart);
  if (!row) throw new errors.NotFoundError('Key not found');

  let value;
  switch (row.type) {
    case 'string':
      value = JSON.parse(row.value).v;
      break;
    case 'list':
      value = JSON.parse(row.value).v;
      break;
    case 'set':
      value = [...new Set(JSON.parse(row.value).v)].sort();
      break;
    case 'hash':
      value = JSON.parse(row.value).v;
      break;
    case 'zset': {
      const parsed = JSON.parse(row.value).v;
      value = parsed.entries.map((entry) => ({ member: entry.m, score: entry.s }));
      break;
    }
    default:
      value = null;
  }

  return {
    ...toPublicKey(row),
    bytes: Buffer.byteLength(row.value, 'utf8'),
    ttlMs: row.expires_at === null ? null : Math.max(0, row.expires_at - Date.now()),
    value,
  };
}

async function deleteKey(dbPublicId, user, keyName) {
  const dbRecord = await loadAuthorizedDatabase(dbPublicId, user);
  requireActive(dbRecord);
  requireWritePermission(user);
  if (IS_REMOTE) {
    return remoteDriver.execute(dbRecord.namespace, 'DEL', [keyName]);
  }
  return engine.executeDatabaseCommand(dbRecord.id, 'DEL', [keyName]);
}

async function expireKey(dbPublicId, user, keyName, expiresInMs) {
  const dbRecord = await loadAuthorizedDatabase(dbPublicId, user);
  requireActive(dbRecord);
  requireWritePermission(user);
  if (IS_REMOTE) {
    return remoteDriver.execute(dbRecord.namespace, 'PEXPIRE', [keyName, expiresInMs]);
  }
  return engine.executeDatabaseCommand(dbRecord.id, 'PEXPIRE', [keyName, expiresInMs]);
}

async function persistKey(dbPublicId, user, keyName) {
  rejectPersist('PERSIST'); // mandatory-expiry policy: never removes a TTL
}

async function setString(dbPublicId, user, keyName, { value, expiresInMs }) {
  const dbRecord = await loadAuthorizedDatabase(dbPublicId, user);
  requireActive(dbRecord);
  requireWritePermission(user);
  const args = [keyName, value];
  if (expiresInMs) args.push('PX', expiresInMs);
  return executeCommand(dbRecord.public_id, user, 'SET', args);
}

/** Danger-zone helper: wipe every key in this database, keeping the database itself. */
async function flushDatabase(dbPublicId, user, context = {}) {
  await executeCommand(dbPublicId, user, 'FLUSHDB', []);
  audit.record({
    actorUserId: user.id,
    action: 'database.flush',
    targetType: 'database',
    targetId: dbPublicId,
    requestId: context.requestId,
  });
  return { flushed: true };
}

/* --------------------------------- Command usage tracking -------------------------------- */

/** Today's date in UTC as YYYY-MM-DD, used as the partition key for daily counters. */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/** Increment the per-user, per-day, per-command usage counter. Fire-and-forget
    so a tracking failure never breaks a working command. */
async function recordCommandUsage(userId, command) {
  try {
    const usages = await store.getCommandUsages();
    await usages.findOneAndUpdate(
      { user_id: Number(userId), date: todayUtc(), command: String(command).toUpperCase() },
      { $inc: { count: 1 }, $setOnInsert: { created_at: new Date().toISOString() } },
      { upsert: true },
    );
  } catch (_err) {
    /* usage tracking is best-effort; never fail a command because of it */
  }
}

/** Return command usage for the last `days` days, grouped by date and command.
    Result: [ { date, command, count }, ... ] sorted by date desc, command asc. */
async function getCommandUsage(userId, days = 7) {
  const usages = await store.getCommandUsages();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const rows = await usages.aggregate([
    { $match: { user_id: Number(userId), date: { $gte: cutoffStr } } },
    { $group: { _id: { date: '$date', command: '$command' }, count: { $sum: '$count' } } },
    { $project: { _id: 0, date: '$_id.date', command: '$_id.command', count: '$count' } },
    { $sort: { date: -1, command: 1 } },
  ]).toArray();
  return rows;
}

module.exports = {
  loadAuthorizedDatabase,
  bumpDatabaseRecordCacheEpoch,
  executeCommand,
  executePipeline,
  applyRateRules,
  browseKeys,
  getKeyDetail,
  deleteKey,
  expireKey,
  persistKey,
  setString,
  flushDatabase,
  recordCommandUsage,
  getCommandUsage,
};
