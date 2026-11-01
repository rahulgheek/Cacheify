'use strict';

/**
 * Request-scoped phase timing (core) — AsyncLocalStorage so any awaited subsystem
 * (remote Redis driver, engine, ...) can attribute wall-clock time to the HTTP
 * request it served, and every response can expose it via Server-Timing.
 *
 * The store is opened by buildApp() as the FIRST middleware and read by the
 * envelope helpers (before body serialization) and the error boundary. No phase
 * attribution happens outside a request (timers/cron are unaffected).
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

/** Opens the timing context for one request; returns success so it can be
    used directly as the first Express middleware. */
function open(_req, _res, next) {
  const store = { startedAt: process.hrtime.bigint(), phases: [] };
  return als.run(store, next);
}

/** Record one completed phase hit (name + duration ms). */
function track(name, durationMs) {
  const store = als.getStore();
  if (!store) return;
  store.phases.push({ name, ms: durationMs });
}

/** "Server-Timing"-ready summary: total first, then named phase totals. */
function summary() {
  const store = als.getStore();
  if (!store) return null;
  const totalMs = Number(process.hrtime.bigint() - store.startedAt) / 1e6;
  const byName = new Map();
  for (const { name, ms } of store.phases) {
    const cur = byName.get(name);
    const [count, sum] = cur || [0, 0];
    byName.set(name, [count + 1, sum + ms]);
  }
  const header =
    `total;dur=${totalMs.toFixed(1)}` +
    [...byName.entries()]
      .map(([name, [count, sum]]) => `, ${name};dur=${sum.toFixed(1)};desc="${count} call${count === 1 ? '' : 's'}"`)
      .join('');
  return header;
}

/** Attach the Server-Timing header when a timing context is open. */
function setHeader(res) {
  const header = summary();
  if (header && !res.headersSent) res.setHeader('Server-Timing', header);
}

module.exports = { open, track, summary, setHeader };
