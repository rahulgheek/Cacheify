'use strict';

/**
 * Data-plane routes: transport only for the Redis command API and the
 * REST convenience endpoints used by the UI. AuthN at edge, AuthZ + quotas
 * inside the service.
 */

const express = require('express');
const { attachUser, requireAuth, rateLimit, validate } = require('../../core/middleware');
const { ok, created } = require('../../core/envelope');
const errors = require('../../core/errors');
const { config } = require('../../core/env');
const service = require('./service');
const {
  commandSchema, pipelineSchema, stringPutSchema, expireSchema, listKeysQuery, rateLimitSchema,
} = require('./schema');

const router = express.Router();

router.use(attachUser, requireAuth, rateLimit({ keyPrefix: 'data' }));

function handle(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/* Queue-with-backpressure: writes that reach Redis are capped per database.
   Over the cap the caller gets 429 + Retry-After instead of a held socket. */
const dbInflight = new Map(); // dbPublicId -> active count

function inflightGuard(handler) {
  return (req, res, next) => {
    const id = req.params.dbId;
    const active = dbInflight.get(id) || 0;
    if (active >= config.maxInflightPerDb) {
      res.setHeader('Retry-After', '1');
      return next(new errors.RateLimitError());
    }
    dbInflight.set(id, active + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const current = dbInflight.get(id);
      if (current !== undefined) {
        if (current <= 1) dbInflight.delete(id);
        else dbInflight.set(id, current - 1);
      }
    };
    // close fires on normal response completion too and fires exactly once
    // per request-response cycle, so this is a leak-free release point.
    res.on('close', release);
    return handler(req, res, next);
  };
}

/* Command console endpoint (single or pipeline). */
router.post('/:dbId/command', validate(commandSchema), inflightGuard(handle(async (req, res) => {
  const result = await service.executeCommand(req.params.dbId, req.user, req.body.command, req.body.args);
  return ok(res, { result });
})));

router.post('/:dbId/pipeline', validate(pipelineSchema), inflightGuard(handle(async (req, res) => {
  const results = await service.executePipeline(req.params.dbId, req.user, req.body.commands);
  return ok(res, { results });
})));

/* Compound deterministic rate limiting: fixed-window counters as ordinary
   (TTL-armed) keys. One call can evaluate up to 20 rules Rails-style. */
router.post('/:dbId/rate-limit', validate(rateLimitSchema), inflightGuard(handle(async (req, res) => {
  const results = await service.applyRateRules(req.params.dbId, req.user, req.validated.body.rules);
  return ok(res, { results });
})));

/* Key browsing + detail (used by the UI key table). */
router.get('/:dbId/keys', validate(listKeysQuery, 'query'), handle(async (req, res) => {
  const page = await service.browseKeys(req.params.dbId, req.user, req.validated.query);
  return ok(res, { keys: page.keys }, { cursor: page.meta.cursor });
}));

router.get('/:dbId/keys/:key', handle(async (req, res) => {
  return ok(res, { key: await service.getKeyDetail(req.params.dbId, req.user, req.params.key) });
}));

router.delete('/:dbId/keys/:key', handle(async (req, res) => {
  const deleted = await service.deleteKey(req.params.dbId, req.user, req.params.key);
  return ok(res, { deleted: Boolean(deleted) });
}));

/* String convenience endpoint (typed commands for forms/scripts). */
router.put('/:dbId/strings/:key', validate(stringPutSchema), inflightGuard(handle(async (req, res) => {
  const result = await service.setString(req.params.dbId, req.user, req.params.key, req.body);
  return created(res, { result });
})));

/* TTL management. */
router.post('/:dbId/keys/:key/expire', validate(expireSchema), handle(async (req, res) => {
  const applied = await service.expireKey(req.params.dbId, req.user, req.params.key, req.body.expiresInMs);
  return ok(res, { applied: Boolean(applied) });
}));

router.delete('/:dbId/keys/:key/expire', handle(async (req, res) => {
  const applied = await service.persistKey(req.params.dbId, req.user, req.params.key);
  return ok(res, { applied: Boolean(applied) });
}));

module.exports = router;
