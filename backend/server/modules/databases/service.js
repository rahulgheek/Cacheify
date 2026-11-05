'use strict';

/** Databases service: ownership authorization, quotas, orchestration. */

const { config } = require('../../core/env');
const { toPublicDatabase } = require('../../core/dto');
const { shortNamespace } = require('../../core/crypto');
const errors = require('../../core/errors');
const audit = require('../../core/audit');
const remoteDriver = require('../data/remote-driver');
const keyStore = require('../data/key-store');
const dal = require('./dal');

const IS_REMOTE = config.redis.mode === 'remote';

function toPublicWithOwner(row) {
  return { ...toPublicDatabase(row), ownerId: row.owner_user_id };
}

async function loadAuthorized(publicIdValue, user, { allowAdmin = true } = {}) {
  const row = await dal.findByPublicId(publicIdValue);
  if (!row) throw new errors.NotFoundError('Database not found');
  if (row.owner_user_id !== user.id && !(allowAdmin && user.role === 'admin')) {
    // 404 instead of 403 avoids leaking other tenants' resource existence.
    throw new errors.NotFoundError('Database not found');
  }
  return row;
}

/** Stats in whichever backend holds the keys (remote mode counts via SCAN). */
async function statsRow(row, user) {
  if (IS_REMOTE) {
    return remoteDriver.statsFor(row.namespace, {
      maxKeysPerDb: user ? user.max_keys_per_db : 10_000,
    });
  }
  return embeddedStats(row.id);
}

/* Local-engine aggregate (redis_keys lives in MongoDB). */
async function embeddedStats(dbId) {
  const { byTypeRows, expiringKeys } = await keyStore.statsByType(dbId);
  const byType = { string: 0, list: 0, set: 0, hash: 0, zset: 0 };
  let totalKeys = 0;
  let totalBytes = 0;
  for (const row of byTypeRows) {
    byType[row.type] = row.n;
    totalKeys += row.n;
    totalBytes += row.bytes;
  }
  return { totalKeys, totalBytes, expiringKeys, byType };
}

async function listDatabases(user) {
  const rows = user.role === 'admin' ? await dal.listAll() : await dal.listByOwner(user.id);
  const withStats = await Promise.all(
    rows.map(async (row) => {
      const stats = await statsRow(row, user);
      return toPublicDatabase(row, stats);
    }),
  );
  return user.role === 'admin'
    ? rows.map((row, index) => ({ ...withStats[index], ownerId: row.owner_user_id }))
    : withStats;
}

async function createDatabase(user, { name, description }, context = {}) {
  const used = await dal.countByOwner(user.id);
  if (used >= user.max_databases) {
    throw new errors.QuotaExceededError(
      `Plan limit reached: at most ${user.max_databases} active database(s)`,
      [{ field: 'quota', issue: 'maxDatabases' }],
    );
  }
  if (await dal.hasActiveWithName(user.id, name)) {
    throw new errors.ConflictError('You already have an active database with this name');
  }
  const row = await dal.insert({
    ownerUserId: user.id,
    name,
    description,
    namespace: shortNamespace(),
  });
  await audit.record({
    actorUserId: user.id,
    action: 'database.create',
    targetType: 'database',
    targetId: row.public_id,
    metadata: { name },
    requestId: context.requestId,
  });
  return toPublicDatabase(row, await statsRow(row, user));
}

async function getDatabase(publicIdValue, user) {
  const row = await loadAuthorized(publicIdValue, user);
  return toPublicDatabase(row, await statsRow(row, user));
}

async function updateDatabase(publicIdValue, patch, user, context = {}) {
  const row = await loadAuthorized(publicIdValue, user, { allowAdmin: false });
  if (patch.name && patch.name !== row.name) {
    if (await dal.hasOtherWithName(user.id, patch.name, row.public_id)) {
      throw new errors.ConflictError('You already have a database with this name');
    }
  }
  const updated = await dal.update(publicIdValue, patch);
  // Status (archive → read-only) and name changes must be instantly visible
  // to the data plane's dbRecord cache.
  if ('status' in patch || 'name' in patch) {
    require('../data/service').bumpDatabaseRecordCacheEpoch();
  }
  await audit.record({
    actorUserId: user.id,
    action: 'database.update',
    targetType: 'database',
    targetId: row.public_id,
    requestId: context.requestId,
  });
  return toPublicDatabase(updated, await statsRow(updated, user));
}

async function deleteDatabase(publicIdValue, user, context = {}) {
  const row = await loadAuthorized(publicIdValue, user, { allowAdmin: false });
  // Remote namespace cleanup happens BEFORE metadata deletion: no tenant data
  // must outlive its registry row.
  if (IS_REMOTE) {
    try {
      await remoteDriver.deleteNamespace(row.namespace);
    } catch (err) {
      // Keys remain on the shared server if cleanup fails; fail the delete so
      // tenants never silently leak data behind a deleted database row.
      throw new errors.ServiceUnavailableError(
        `Remote key cleanup failed: ${err.message || 'connection error'}`,
      );
    }
  }
  // Local-engine key data (MongoDB redis_keys) first, then metadata (Mongo).
  if (!IS_REMOTE) {
    await keyStore.deleteByDatabase(row.id);
  }
  await dal.deleteRow(publicIdValue);
  await audit.record({
    actorUserId: user.id,
    action: 'database.delete',
    targetType: 'database',
    targetId: row.public_id,
    metadata: { name: row.name },
    requestId: context.requestId,
  });
  return { deleted: true, id: row.public_id };
}

module.exports = {
  listDatabases,
  createDatabase,
  getDatabase,
  updateDatabase,
  deleteDatabase,
  loadAuthorized,
};
