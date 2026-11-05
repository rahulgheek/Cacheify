'use strict';

/**
 * Mongo latency probe — bespoke runner for the platform's storage tier.
 *
 * Run ON THE SERVER (where the Express API lives):
 *   node scripts/mongo-latency-probe.js            (backend dir, so .env resolves)
 *
 * Why: one /command request does 6-8 serial Mongo round trips (auth scope,
 * database owner, key rows, usage counters). Command latency therefore =
 *inaus RTT × serial queries + work. This script isolates that RTT:
 *   ~1-5 ms/query  → co-located storage; per-command time is spent in trip
 *                    count, trim the per-command query stack.
 *   ~150+ ms/query → remote cluster; relocating Mongo to the server region
 *                    is the first-order fix, trimming queries second.
 *
 * It measures three things against the live cluster:
 *   ping   : no-op awaitable (RTT floor)
 *   users findOne  : control-plane lookup shape (auth stack)
 *   keys findOne   : redis_keys lookup shape (data plane)
 */

const fs = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');

 (function loadEnv() {
  try {
    const parsed = require('dotenv').parse(fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8'));
    for (const [k, v] of Object.entries(parsed)) if (!(k in process.env)) process.env[k] = v;
  } catch (_err) { /* .env optional */ }
})();

const URI = (process.env.MONGODB_URI || '').trim();
const DB = (process.env.MONGODB_DB || 'cacheify').trim();

if (!URI) {
  console.error('MONGODB_URI not set — run from the backend directory with its .env present.');
  process.exit(1);
}

function stats(samples) {
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  return `avg ${avg.toFixed(1)}ms  min ${min.toFixed(1)}ms  max ${max.toFixed(1)}ms`;
}

async function timeSeries(fn, n, warmup = 3) {
  const out = [];
  for (let i = 0; i < n + warmup; i += 1) {
    const start = performance.now();
    await fn();
    const ms = performance.now() - start;
    if (i >= warmup) out.push(ms);
  }
  return out;
}

(async () => {
  const client = new MongoClient(URI, { maxPoolSize: 10 });
  const connectStart = performance.now();
  await client.connect();
  console.log(`connect: ${(performance.now() - connectStart).toFixed(0)}ms (no-op: pooling, not per-query)`);

  const db = client.db(DB);
  const N = 20;

  const pings = await timeSeries(() => db.command({ ping: 1 }), N);
  console.log(`ping x${N}      : ${stats(pings)}`);

  const users = await timeSeries(
    () => db.collection('users').findOne({}, { projection: { _id: 1 } }),
    N,
  );
  console.log(`users find x${N} : ${stats(users)}`);

  const keys = await timeSeries(
    () => db.collection('redis_keys').findOne(
      { $or: [{ expires_at: null }, { expires_at: { $gt: Date.now() } }] },
      { projection: { _id: 1, name: 1 } },
    ),
    N,
  );
  console.log(`keys find x${N} : ${stats(keys)}`);

  const batchCost = (pings.reduce((a, b) => a + b, 0) / pings.length) * 7;
  console.log(`\nserial-query model: a 7-trip /command ≈ ${batchCost.toFixed(0)}ms at this cluster latency`);
  console.log('             (removing trips shaves latency 1:1; co-locating Mongo divides it)');

  await client.close();
  process.exit(0);
})().catch((err) => {
  console.error('probe failed:', err.message);
  process.exit(1);
});
