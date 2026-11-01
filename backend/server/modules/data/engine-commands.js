'use strict';

/**
 * Engine command groups implementing Redis semantics per type.
 * Each executor receives (dbId, args) and returns JSON-safe results.
 * All commands are async against the MongoDB key store.
 * Redis nil is surfaced as null; type errors throw Error with .redis flag.
 */

const {
  expectType, toInt, incrementString, loadSet, saveSet, loadZSet, saveZSet, globToRegExp,
  liveRow, writeValue, decode,
} = require('./engine-core');
const keyStore = require('./key-store');
const { nowMs } = require('./engine-util');
const { config } = require('../../core/env');

/* Mandatory-expiry policy: writes without an explicit TTL get this default. */
function defaultExpiry(nowValue) {
  return nowValue + config.defaultKeyTtlMs;
}

/* --------------------------------- Strings -------------------------------- */

const strings = {
  async get(dbId, [key]) {
    const row = await liveRow(dbId, key);
    if (!row) return null;
    expectType(row, 'string');
    return JSON.parse(row.value).v;
  },

  async set(dbId, args) {
    const [key, value, ...flags] = args;
    const nowValue = nowMs();
    let expiresAt = null;
    let mode = null; // 'NX' | 'XX'
    for (let i = 0; i < flags.length; i += 1) {
      const flag = String(flags[i]).toUpperCase();
      if (flag === 'NX' || flag === 'XX') mode = flag;
      else if (flag === 'EX' || flag === 'PX') {
        const amount = toInt(flags[i + 1]);
        if (amount <= 0) {
          const err = new Error('ERR invalid expire time');
          err.redis = true;
          throw err;
        }
        expiresAt = nowValue + (flag === 'EX' ? amount * 1000 : amount);
        i += 1;
      } else {
        const err = new Error(`ERR unknown option '${flag}'`);
        err.redis = true;
        throw err;
      }
    }
    // Mandatory-expiry policy: SET with no EX/PX re-arms the default TTL
    // (plain SET would otherwise clear the expiry and make the key immortal).
    if (expiresAt === null) expiresAt = defaultExpiry(nowValue);
    const existing = await keyStore.liveRow(dbId, key);
    if (mode === 'NX' && existing) return null;
    if (mode === 'XX' && !existing) return null;
    await writeValue(dbId, key, 'string', value, expiresAt, nowValue);
    return 'OK';
  },

  incr(dbId, [key]) {
    return incrementString(dbId, key, 1, nowMs());
  },
  decr(dbId, [key]) {
    return incrementString(dbId, key, -1, nowMs());
  },
  incrby(dbId, [key, delta]) {
    return incrementString(dbId, key, toInt(delta), nowMs());
  },
  decrby(dbId, [key, delta]) {
    return incrementString(dbId, key, -toInt(delta), nowMs());
  },

  async append(dbId, [key, value]) {
    const nowValue = nowMs();
    const row = await keyStore.liveRow(dbId, key);
    const current = row ? JSON.parse(row.value).v : '';
    expectType(row, 'string');
    const appended = String(current) + value;
    await writeValue(
      dbId,
      key,
      'string',
      appended,
      row && row.expires_at !== null ? row.expires_at : null, // store stamps default on null
      nowValue,
    );
    return Buffer.byteLength(appended, 'utf8');
  },

  async strlen(dbId, [key]) {
    const row = await liveRow(dbId, key);
    if (!row) return 0;
    expectType(row, 'string');
    return Buffer.byteLength(String(JSON.parse(row.value).v), 'utf8');
  },

  async getrange(dbId, [key, start, end]) {
    const value = await strings.get(dbId, [key]);
    if (value === null) return null;
    const len = value.length;
    let s = toInt(start) < 0 ? len + toInt(start) : toInt(start);
    let e = toInt(end) < 0 ? len + toInt(end) : toInt(end);
    s = Math.max(0, Math.min(s, len));
    e = Math.max(0, Math.min(e, len - 1));
    return s > e ? '' : value.slice(s, e + 1);
  },

  async mget(dbId, keys) {
    const results = await Promise.all(keys.map((key) => strings.get(dbId, [key])));
    return results;
  },

  async mset(dbId, pairs) {
    const nowValue = nowMs();
    const expiry = defaultExpiry(nowValue);
    for (let i = 0; i < pairs.length; i += 2) {
      await writeValue(dbId, pairs[i], 'string', pairs[i + 1], expiry, nowValue);
    }
    return 'OK';
  },

  setex(dbId, [key, seconds, value]) {
    return strings.set(dbId, [key, value, 'EX', seconds]);
  },
  psetex(dbId, [key, ms, value]) {
    return strings.set(dbId, [key, value, 'PX', ms]);
  },
};

/* ----------------------------------- Keys --------------------------------- */

const keyCommands = {
  async exists(dbId, keys) {
    let count = 0;
    for (const key of keys) {
      const row = await liveRow(dbId, key);
      if (row) count += 1;
    }
    return count;
  },

  async del(dbId, keys) {
    let count = 0;
    for (const key of keys) {
      count += await keyStore.deleteByName(dbId, key);
    }
    return count;
  },

  async type(dbId, [key]) {
    const row = await liveRow(dbId, key);
    return row ? row.type : 'none';
  },

  async keys(dbId, [pattern]) {
    const re = globToRegExp(String(pattern));
    const { names } = await keyStore.liveNames(dbId);
    return names.filter((name) => re.test(name));
  },

  async scan(dbId, args) {
    const [cursorArg, ...rest] = args;
    let cursor = toInt(cursorArg);
    if (cursor < 0) {
      const err = new Error('ERR invalid cursor');
      err.redis = true;
      throw err;
    }
    let match = null;
    let countHint = 10;
    for (let i = 0; i < rest.length; i += 1) {
      const opt = String(rest[i]).toUpperCase();
      if (opt === 'MATCH') { match = globToRegExp(String(rest[i + 1])); i += 1; }
      else if (opt === 'COUNT') { countHint = toInt(rest[i + 1]); i += 1; }
    }
    const batchLimit = Math.min(Math.max(countHint, 1), 1000);
    let { names } = await keyStore.liveNames(dbId);
    if (match) names = names.filter((name) => match.test(name));
    const page = names.slice(cursor, cursor + batchLimit);
    const nextCursor = cursor + page.length < names.length ? cursor + page.length : 0;
    return { cursor: nextCursor, keys: page };
  },

  expire(dbId, [key, seconds]) {
    return keyCommands.pexpire(dbId, [key, toInt(seconds) * 1000]);
  },

  async pexpire(dbId, [key, ms]) {
    const nowValue = nowMs();
    const row = await liveRow(dbId, key);
    if (!row) return 0;
    // Value round-trips DECODED (not its {"v":...} wrapper): passing the raw
    // parsed row back through writeValue re-encodes it as {"v":{"v":...}}
    // (double wrap), which silently corrupts every later GET/INCR on the key.
    await writeValue(dbId, key, row.type, decode(row.type, JSON.parse(row.value)), nowValue + toInt(ms), nowValue);
    return 1;
  },

  async ttl(dbId, [key]) {
    const p = await keyCommands.pttl(dbId, [key]);
    if (p <= -2) return -2;
    if (p === -1) return -1;
    return Math.ceil(p / 1000);
  },

  async pttl(dbId, [key]) {
    const row = await keyStore.liveRow(dbId, key);
    if (!row) return -2;
    if (row.expires_at === null) return -1;
    const remaining = row.expires_at - nowMs();
    if (remaining > 0) return remaining;
    return -2;
  },

  async persist(dbId, [key]) {
    /* Mandatory-expiry policy: every key on the platform expires; the only
       re-arm path is a new EXPIRE/PEXPIRE. This command answers 0 always. */
    void key;
    void dbId;
    return 0;
  },

  async expiretime(dbId, [key]) {
    const row = await keyStore.liveRow(dbId, key);
    if (!row) return -2;
    if (row.expires_at === null) return -1;
    return Math.floor(row.expires_at / 1000);
  },

  async rename(dbId, [key, newKey]) {
    const nowValue = nowMs();
    const source = await keyStore.liveRow(dbId, key);
    if (!source) {
      const err = new Error('ERR no such key');
      err.redis = true;
      throw err;
    }
    await keyStore.deleteByName(dbId, newKey);
    // Rewrite under the new name, then drop the old row (unique name index).
    // Same decode rule as pexpire: re-encoding the raw row double-wraps {"v":...}.
    await writeValue(dbId, newKey, source.type, decode(source.type, JSON.parse(source.value)), source.expires_at, nowValue);
    await keyStore.deleteByName(dbId, key);
    return 'OK';
  },
};

/* ----------------------------------- Lists -------------------------------- */

async function listValues(dbId, key) {
  const row = await liveRow(dbId, key);
  expectType(row, 'list');
  return row ? JSON.parse(row.value).v : null;
}

/** Save a list state that came from an existing row (its TTL is preserved).
    Empty states delete the row; store stamps the default expiry on null ones. */
function saveListRow(dbId, key, listValues, existingRow) {
  const nowValue = nowMs();
  if (listValues.length === 0 && existingRow) {
    return keyStore.deleteById(dbId, existingRow.id);
  }
  return writeValue(
    dbId, key, 'list', listValues,
    existingRow && existingRow.expires_at !== null ? existingRow.expires_at : null,
    nowValue,
  );
}

const lists = {
  async lpush(dbId, [key, ...values]) {
    const nowValue = nowMs();
    const row = await liveRow(dbId, key);
    expectType(row, 'list');
    const current = row ? JSON.parse(row.value).v : [];
    let next = current;
    for (const value of values) next = [value, ...next];
    await writeValue(
      dbId, key, 'list', next,
      row && row.expires_at !== null ? row.expires_at : null, // null => default expiry when fresh
      nowValue,
    );
    return next.length;
  },

  async rpush(dbId, [key, ...values]) {
    const nowValue = nowMs();
    const row = await liveRow(dbId, key);
    expectType(row, 'list');
    const next = [...(row ? JSON.parse(row.value).v : []), ...values];
    await writeValue(
      dbId, key, 'list', next,
      row && row.expires_at !== null ? row.expires_at : null,
      nowValue,
    );
    return next.length;
  },

  async lpop(dbId, [key, countArg]) {
    const row = await liveRow(dbId, key);
    if (!row) return countArg != null ? [] : null;
    expectType(row, 'list');
    const values = JSON.parse(row.value).v;
    if (values.length === 0) return countArg != null ? [] : null;
    const n = countArg != null ? Math.max(0, Math.min(toInt(countArg), values.length)) : 1;
    const popped = values.splice(0, n);
    await saveListRow(dbId, key, values, row);
    return countArg != null ? popped : popped[0];
  },

  async rpop(dbId, [key, countArg]) {
    const row = await liveRow(dbId, key);
    if (!row) return countArg != null ? [] : null;
    expectType(row, 'list');
    const values = JSON.parse(row.value).v;
    if (values.length === 0) return countArg != null ? [] : null;
    const n = countArg != null ? Math.max(0, Math.min(toInt(countArg), values.length)) : 1;
    const popped = values.splice(values.length - n, n);
    await saveListRow(dbId, key, values, row);
    return countArg != null ? popped : popped[0];
  },

  async lrange(dbId, [key, start, stop]) {
    const values = await listValues(dbId, key);
    if (!values) return [];
    let s = toInt(start) < 0 ? values.length + toInt(start) : toInt(start);
    let e = toInt(stop) < 0 ? values.length + toInt(stop) : toInt(stop);
    s = Math.max(0, Math.min(s, values.length));
    e = Math.max(-1, Math.min(e, values.length - 1));
    return s > e ? [] : values.slice(s, e + 1);
  },

  async llen(dbId, [key]) {
    const values = await listValues(dbId, key);
    return values ? values.length : 0;
  },

  async lindex(dbId, [key, index]) {
    const values = await listValues(dbId, key);
    if (!values) return null;
    const i = toInt(index) < 0 ? values.length + toInt(index) : toInt(index);
    return i >= 0 && i < values.length ? values[i] : null;
  },

  async lset(dbId, [key, index, value]) {
    const row = await liveRow(dbId, key);
    if (!row) {
      const err = new Error('ERR no such key');
      err.redis = true;
      throw err;
    }
    expectType(row, 'list');
    const values = JSON.parse(row.value).v;
    const i = toInt(index) < 0 ? values.length + toInt(index) : toInt(index);
    if (i < 0 || i >= values.length) {
      const err = new Error('ERR index out of range');
      err.redis = true;
      throw err;
    }
    values[i] = value;
    await saveListRow(dbId, key, values, row);
    return 'OK';
  },

  async ltrim(dbId, [key, start, stop]) {
    const row = await liveRow(dbId, key);
    if (!row) {
      const err = new Error('ERR no such key');
      err.redis = true;
      throw err;
    }
    expectType(row, 'list');
    const values = JSON.parse(row.value).v;
    let s = toInt(start) < 0 ? values.length + toInt(start) : toInt(start);
    let e = toInt(stop) < 0 ? values.length + toInt(stop) : toInt(stop);
    s = Math.max(0, Math.min(s, values.length));
    e = Math.max(-1, Math.min(e, values.length - 1));
    await saveListRow(dbId, key, s > e ? [] : values.slice(s, e + 1), row);
    return 'OK';
  },

  async lrem(dbId, [key, count, value]) {
    const row = await liveRow(dbId, key);
    if (!row) return 0;
    expectType(row, 'list');
    const values = JSON.parse(row.value).v;
    const c = toInt(count);
    let removed = 0;
    if (c > 0) {
      for (let i = 0; i < values.length && removed < c;) {
        if (values[i] === value) { values.splice(i, 1); removed += 1; } else i += 1;
      }
    } else if (c < 0) {
      for (let i = values.length - 1; i >= 0 && removed < -c;) {
        if (values[i] === value) { values.splice(i, 1); removed += 1; } else i -= 1;
      }
    } else {
      for (let i = values.length - 1; i >= 0;) {
        if (values[i] === value) { values.splice(i, 1); removed += 1; } else i -= 1;
      }
    }
    await saveListRow(dbId, key, values, row);
    return removed;
  },
};

/* ----------------------------------- Sets --------------------------------- */

const sets = {
  async sadd(dbId, [key, ...members]) {
    const nowValue = nowMs();
    const loaded = await loadSet(dbId, key, nowValue);
    if (!loaded) {
      const fresh = new Set(members);
      await saveSet(dbId, key, fresh, null, nowValue);
      return fresh.size;
    }
    const before = loaded.set.size;
    for (const member of members) loaded.set.add(member);
    if (loaded.set.size !== before) {
      await saveSet(dbId, key, loaded.set, loaded.row, nowValue);
      return loaded.set.size - before;
    }
    return 0;
  },

  async srem(dbId, [key, ...members]) {
    const nowValue = nowMs();
    const loaded = await loadSet(dbId, key, nowValue);
    if (!loaded) return 0;
    let removed = 0;
    for (const member of members) {
      if (loaded.set.delete(member)) removed += 1;
    }
    if (removed > 0) await saveSet(dbId, key, loaded.set, loaded.row, nowValue);
    return removed;
  },

  async sismember(dbId, [key, member]) {
    const loaded = await loadSet(dbId, key, nowMs());
    return loaded && loaded.set.has(member) ? 1 : 0;
  },

  async smembers(dbId, [key]) {
    const loaded = await loadSet(dbId, key, nowMs());
    return loaded ? [...loaded.set].sort() : [];
  },

  async scard(dbId, [key]) {
    const loaded = await loadSet(dbId, key, nowMs());
    return loaded ? loaded.set.size : 0;
  },

  async sinter(dbId, keys) {
    const nowValue = nowMs();
    const loaded = await Promise.all(keys.map((key) => loadSet(dbId, key, nowValue)));
    if (loaded.some((entry) => entry === null)) return [];
    return [...loaded[0].set].filter((member) => loaded.every((entry) => entry.set.has(member))).sort();
  },

  async sunion(dbId, keys) {
    const nowValue = nowMs();
    const result = new Set();
    const loaded = await Promise.all(keys.map((key) => loadSet(dbId, key, nowValue)));
    for (const entry of loaded) {
      if (entry) for (const member of entry.set) result.add(member);
    }
    return [...result].sort();
  },

  async sdiff(dbId, keys) {
    const nowValue = nowMs();
    const base = await loadSet(dbId, keys[0], nowValue);
    if (!base) return [];
    const others = await Promise.all(keys.slice(1).map((key) => loadSet(dbId, key, nowValue)));
    return [...base.set].filter((member) => !others.some((entry) => entry && entry.set.has(member))).sort();
  },
};

/* ----------------------------------- Hashes ------------------------------- */

async function loadHash(dbId, key) {
  const row = await liveRow(dbId, key);
  expectType(row, 'hash');
  return row ? { row, hash: JSON.parse(row.value).v } : null;
}

async function saveHash(dbId, key, hash, existingRow) {
  const nowValue = nowMs();
  if (Object.keys(hash).length === 0 && existingRow) {
    await keyStore.deleteById(dbId, existingRow.id);
    return;
  }
  await writeValue(
    dbId, key, 'hash', hash,
    existingRow && existingRow.expires_at !== null ? existingRow.expires_at : null,
    nowValue,
  );
}

const hashes = {
  async hset(dbId, [key, ...fieldPairs]) {
    const nowValue = nowMs();
    const loaded = await loadHash(dbId, key);
    const hash = loaded ? loaded.hash : {};
    const before = Object.keys(hash).length;
    for (let i = 0; i + 1 < fieldPairs.length; i += 2) hash[fieldPairs[i]] = fieldPairs[i + 1];
    await saveHash(dbId, key, hash, loaded ? loaded.row : null);
    return Object.keys(hash).length - before;
  },

  async hget(dbId, [key, field]) {
    const loaded = await loadHash(dbId, key);
    return loaded && field in loaded.hash ? loaded.hash[field] : null;
  },

  async hgetall(dbId, [key]) {
    const loaded = await loadHash(dbId, key);
    return loaded ? loaded.hash : {};
  },

  async hdel(dbId, [key, ...fields]) {
    const loaded = await loadHash(dbId, key);
    if (!loaded) return 0;
    let removed = 0;
    for (const field of fields) {
      if (field in loaded.hash) { delete loaded.hash[field]; removed += 1; }
    }
    if (removed > 0) await saveHash(dbId, key, loaded.hash, loaded.row);
    return removed;
  },

  async hkeys(dbId, [key]) {
    const loaded = await loadHash(dbId, key);
    return loaded ? Object.keys(loaded.hash).sort() : [];
  },

  async hvals(dbId, [key]) {
    const loaded = await loadHash(dbId, key);
    return loaded ? Object.keys(loaded.hash).sort().map((field) => loaded.hash[field]) : [];
  },

  async hlen(dbId, [key]) {
    const loaded = await loadHash(dbId, key);
    return loaded ? Object.keys(loaded.hash).length : 0;
  },

  async hexists(dbId, [key, field]) {
    const loaded = await loadHash(dbId, key);
    return loaded && field in loaded.hash ? 1 : 0;
  },
};

/* --------------------------------- Sorted sets ---------------------------- */

const zsets = {
  async zadd(dbId, [key, ...scoreMembers]) {
    if (scoreMembers.length < 2 || scoreMembers.length % 2 !== 0) {
      const err = new Error('ERR syntax error');
      err.redis = true;
      throw err;
    }
    const nowValue = nowMs();
    const loaded = await loadZSet(dbId, key, nowValue);
    const state = loaded || { seq: 0, entries: [] };
    let added = 0;
    for (let i = 0; i + 1 < scoreMembers.length; i += 2) {
      const score = Number(scoreMembers[i]);
      if (!Number.isFinite(score)) {
        const err = new Error('ERR value is not a valid float');
        err.redis = true;
        throw err;
      }
      const member = scoreMembers[i + 1];
      const existing = state.entries.find((entry) => entry.m === member);
      if (existing) {
        existing.s = score;
        existing.seq = state.seq + 1;
        state.seq += 1;
      } else {
        state.entries.push({ s: score, m: member, seq: state.seq + 1 });
        state.seq += 1;
        added += 1;
      }
    }
    state.entries.sort((a, b) => (a.s - b.s) || (a.m < b.m ? -1 : a.m > b.m ? 1 : a.seq - b.seq));
    await saveZSet(dbId, key, state, loaded ? loaded.row : null, nowValue);
    return added;
  },

  async zscore(dbId, [key, member]) {
    const loaded = await loadZSet(dbId, key, nowMs());
    if (!loaded) return null;
    const entry = loaded.entries.find((item) => item.m === member);
    return entry ? entry.s : null;
  },

  async zcard(dbId, [key]) {
    const loaded = await loadZSet(dbId, key, nowMs());
    return loaded ? loaded.entries.length : 0;
  },

  async zrem(dbId, [key, ...members]) {
    const loaded = await loadZSet(dbId, key, nowMs());
    if (!loaded) return 0;
    const before = loaded.entries.length;
    loaded.entries = loaded.entries.filter((entry) => !members.includes(entry.m));
    if (loaded.entries.length !== before) {
      await saveZSet(dbId, key, loaded, loaded.row, nowMs());
      return before - loaded.entries.length;
    }
    return 0;
  },

  async zrange(dbId, [key, start, stop, ...opts]) {
    const withScores = opts.some((opt) => String(opt).toUpperCase() === 'WITHSCORES');
    const loaded = await loadZSet(dbId, key, nowMs());
    if (!loaded) return [];
    let s = toInt(start) < 0 ? loaded.entries.length + toInt(start) : toInt(start);
    let e = toInt(stop) < 0 ? loaded.entries.length + toInt(stop) : toInt(stop);
    s = Math.max(0, Math.min(s, loaded.entries.length));
    e = Math.max(-1, Math.min(e, loaded.entries.length - 1));
    const slice = s > e ? [] : loaded.entries.slice(s, e + 1);
    if (!withScores) return slice.map((entry) => entry.m);
    return slice.flatMap((entry) => [entry.m, String(entry.s)]);
  },
};

module.exports = { strings, keyCommands, lists, sets, hashes, zsets };
