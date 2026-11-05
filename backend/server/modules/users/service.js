'use strict';

/** Users service (admin control plane). */

const { config } = require('../../core/env');
const { toPublicUser } = require('../../core/dto');
const errors = require('../../core/errors');
const audit = require('../../core/audit');
const remoteDriver = require('../data/remote-driver');
const databasesDal = require('../databases/dal');
const dal = require('./dal');

const IS_REMOTE = config.redis.mode === 'remote';

/** Remote-mode usage: key data lives on the shared Redis server, namespaced. */
async function remoteUsageStats(userRow) {
  const base = await dal.baseStats(userRow);
  const rows = await databasesDal.listByOwner(userRow.id);
  let total = 0;
  for (const row of rows) {
    total += await remoteDriver.countNamespace(
      row.namespace,
      userRow.max_keys_per_db + 1,
    );
  }
  return { ...base, keys: { total, bytes: null } };
}

async function embeddedUsageStats(userRow) {
  const base = await dal.baseStats(userRow);
  const rows = await databasesDal.listByOwner(userRow.id);
  const ids = rows.map((row) => row.id);
  return { ...base, keys: await dal.embeddedKeyStats(userRow, ids) };
}

async function listUsers(query) {
  const rows = await dal.listPage({ ...query, limit: query.limit + 1 });
  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  return {
    users: items.map(toPublicUser),
    meta: { cursor: hasMore ? rows[query.limit - 1].id : 0 },
  };
}

async function getUser(publicIdValue) {
  const row = await dal.findByPublicId(publicIdValue);
  if (!row) throw new errors.NotFoundError('User not found');
  const usage = IS_REMOTE ? await remoteUsageStats(row) : await embeddedUsageStats(row);
  return { user: toPublicUser(row), usage };
}

async function updateUser(publicIdValue, patch, admin, context = {}) {
  const row = await dal.findByPublicId(publicIdValue);
  if (!row) throw new errors.NotFoundError('User not found');
  if (row.id === admin.id && patch.status === 'suspended') {
    throw new errors.ConflictError('Administrators cannot suspend their own account');
  }
  const updated = await dal.updateByPublicId(publicIdValue, patch);
  // Plan/status changes must be visible instantly to the data plane, whose
  // dbRecord cache carries owner quotas for the cache TTL.
  if (['status', 'maxValueBytes', 'maxKeysPerDb', 'maxDatabases'].some((k) => k in patch)) {
    require('../data/service').bumpDatabaseRecordCacheEpoch();
  }
  await audit.record({
    actorUserId: admin.id,
    action: 'user.admin_update',
    targetType: 'user',
    targetId: publicIdValue,
    metadata: patch,
    requestId: context.requestId,
  });
  return toPublicUser(updated);
}

module.exports = { listUsers, getUser, updateUser };
