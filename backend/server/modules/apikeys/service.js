'use strict';

/** API keys service. Keys are scoped to one database with an explicit permission level. */

const { toPublicApiKey } = require('../../core/dto');
const errors = require('../../core/errors');
const audit = require('../../core/audit');
const dal = require('./dal');

async function listApiKeys(userId) {
  return (await dal.listByUser(userId)).map(toPublicApiKey);
}

async function createApiKey(user, { name, databaseId, permission }, context = {}) {
  const target = await dal.findByDatabasePublicId(databaseId, user.id);
  if (!target) throw new errors.NotFoundError('Database not found');
  // Exactly one active key per database. Revoked keys do not count, so
  // rotation is always: revoke the old key, then mint the replacement.
  const existing = await dal.activeByDatabaseId(target.id);
  if (existing) {
    throw new errors.ConflictError(
      `Database "${target.name}" already has an active API key. Revoke it first to mint a new one.`,
    );
  }
  const { row, plaintext } = await dal.insert(user.id, {
    name,
    databaseId: target.id,
    permission,
  });
  // Re-selected rows lack the JOIN columns; enrich so the DTO carries scope.
  const withScope = { ...row, database_public_id: target.public_id, database_name: target.name };
  await audit.record({
    actorUserId: user.id,
    action: 'api_key.create',
    targetType: 'api_key',
    targetId: row.public_id,
    metadata: {
      name,
      databaseId: target.public_id,
      databaseName: target.name,
      permission,
    },
    requestId: context.requestId,
  });
  // Plaintext is returned exactly once and never stored.
  return { apiKey: toPublicApiKey(withScope), plaintext };
}

/** Current active key for a database (ownership-checked), or null when none. */
async function getDatabaseApiKey(databasePublicId, user) {
  const database = await dal.findByDatabasePublicId(databasePublicId, user.id);
  if (!database) throw new errors.NotFoundError('Database not found');
  const row = await dal.findActiveScopedByDatabase(databasePublicId, user.id);
  return row ? toPublicApiKey(row) : null;
}

async function revokeApiKey(publicIdValue, user, context = {}) {
  const row = await dal.findByPublicIdForUser(publicIdValue, user.id);
  if (!row) throw new errors.NotFoundError('API key not found');
  await dal.revoke(publicIdValue);
  // Revocation must be observable immediately: drop cached key→scope
  // resolutions so the next request re-consults the store.
  require('../../core/middleware').bumpApiKeyCacheEpoch();
  await audit.record({
    actorUserId: user.id,
    action: 'api_key.revoke',
    targetType: 'api_key',
    targetId: row.public_id,
    metadata: { name: row.name },
    requestId: context.requestId,
  });
  return { revoked: true, id: row.public_id };
}

module.exports = { listApiKeys, createApiKey, getDatabaseApiKey, revokeApiKey };
