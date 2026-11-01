'use strict';

/** Deterministic JSON response envelopes for every endpoint. */

const phaseTimer = require('./phase-timer');

function ok(res, data = null, meta = undefined, status = 200) {
  // Request observability: total + phase attribution rides on every envelope
  // (set before serialization; headers are still modifiable here).
  phaseTimer.setHeader(res);
  return res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
}

function created(res, data, meta = undefined) {
  return ok(res, data, meta, 201);
}

module.exports = { ok, created };
