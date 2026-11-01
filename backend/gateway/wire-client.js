'use strict';

/**
 * Minimal RESP test client: speaks raw RESP2 (and reads RESP3 replies) over a
 * plain net socket, so wire-level gateway tests behave exactly like
 * redis-cli / Jedis / redis-py on the byte level. Shared by test-resp.js and
 * test-live-env.js — wire reader for + - : $ * _ % replies.
 */

const net = require('node:net');

class Wire {
  constructor() {
    this.replies = [];
    this.waiters = [];
    this.buffer = Buffer.alloc(0);
    this.closed = false;
  }

  connect(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(port, host, () => resolve(this));
      this.socket.on('error', (err) => reject(err));
      this.socket.on('data', (chunk) => {
        if (global.__raw) global.__raw.push(chunk.toString('latin1').replace(/\r/g, '·').replace(/\n/g, ' '));
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        this.drain();
      });
      this.socket.on('close', () => {
        this.closed = true;
        this.drain();
      });
      setTimeout(() => reject(new Error('connect timeout')), 5000).unref();
    });
  }

  drain() {
    try {
      this.buffer = this.parse(this.buffer);
    } catch (err) {
      this.replies.push({ t: 'reader-error', v: String(err.message) });
    }
    while (this.waiters.length > 0 && this.replies.length > 0) {
      this.waiters.shift()(this.replies.shift());
    }
    if (this.closed && this.replies.length === 0) {
      while (this.waiters.length > 0) this.waiters.shift()({ t: 'closed' });
    }
  }

  read(timeoutMs = 8000) {
    if (this.replies.length > 0) return Promise.resolve(this.replies.shift());
    if (this.closed) return Promise.resolve({ t: 'closed' });
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      setTimeout(() => resolve({ t: 'timeout' }), timeoutMs).unref();
    });
  }

  writeCmd(parts) {
    const chunks = [Buffer.from(`*${parts.length}\r\n`, 'ascii')];
    for (const part of parts) {
      const bytes = Buffer.from(String(part), 'utf8');
      chunks.push(Buffer.from(`$${bytes.length}\r\n`, 'ascii'), bytes, Buffer.from('\r\n', 'ascii'));
    }
    this.socket.write(Buffer.concat(chunks));
  }

  /** Parse the first reply; returns the REMAINING buffer. */
  parse(buffer) {
    if (buffer.length === 0) return buffer;
    const kind = String.fromCharCode(buffer[0]);
    const eol = buffer.indexOf(0x0a);
    if (kind === '+' || kind === '-' || kind === ':' || kind === '#') {
      if (eol === -1) return buffer;
      const text = buffer.subarray(1, eol > 0 && buffer[eol - 1] === 0x0d ? eol - 1 : eol).toString('utf8');
      this.replies.push(
        kind === '+' ? { t: 'status', v: text }
          : kind === '-' ? { t: 'error', v: text }
            : kind === ':' ? { t: 'int', v: Number(text) }
              : { t: 'bool', v: text === 't' },
      );
      return this.parse(buffer.subarray(eol + 1));
    }
    if (kind === '_') {
      if (eol === -1) return buffer;
      this.replies.push({ t: 'null' });
      return this.parse(buffer.subarray(eol + 1));
    }
    if (kind === '$') {
      if (eol === -1) return buffer;
      const len = Number(buffer.subarray(1, eol).toString('ascii'));
      if (len === -1) {
        this.replies.push({ t: 'null' });
        return this.parse(buffer.subarray(eol + 1));
      }
      if (buffer.length < eol + 1 + len + 2) return buffer;
      const value = buffer.subarray(eol + 1, eol + 1 + len).toString('utf8');
      this.replies.push({ t: 'bulk', v: value });
      return this.parse(buffer.subarray(eol + 1 + len + 2));
    }
    if (kind === '*' || kind === '%') {
      if (eol === -1) return buffer;
      const inner = this.parseNested(buffer); // header + children atomically
      if (!inner) return buffer;
      this.replies.push(inner.value);
      return this.parse(buffer.subarray(inner.consumed));
    }
    throw new Error(`unexpected reply byte ${kind}`);
  }

  /** Inner parser for aggregate replies: {value, consumed} or null (partial). */
  parseNested(buffer) {
    if (buffer.length === 0) return null;
    const kind = String.fromCharCode(buffer[0]);
    const eol = buffer.indexOf(0x0a);
    if (kind === '+' || kind === '-' || kind === ':' || kind === '#') {
      if (eol === -1) return null;
      const text = buffer.subarray(1, eol > 0 && buffer[eol - 1] === 0x0d ? eol - 1 : eol).toString('utf8');
      return {
        consumed: eol + 1,
        value: kind === '+' ? { t: 'status', v: text }
          : kind === '-' ? { t: 'error', v: text }
            : kind === ':' ? { t: 'int', v: Number(text) }
              : { t: 'bool', v: text === 't' },
      };
    }
    if (kind === '_') {
      if (eol === -1) return null;
      return { consumed: eol + 1, value: { t: 'null' } };
    }
    if (kind === '$') {
      if (eol === -1) return null;
      const len = Number(buffer.subarray(1, eol).toString('ascii'));
      if (len === -1) return { consumed: eol + 1, value: { t: 'null' } };
      if (buffer.length < eol + 1 + len + 2) return null;
      return {
        consumed: eol + 1 + len + 2,
        value: { t: 'bulk', v: buffer.subarray(eol + 1, eol + 1 + len).toString('utf8') },
      };
    }
    if (kind === '*' || kind === '%') {
      if (eol === -1) return null;
      const count = Number(buffer.subarray(1, eol).toString('ascii'));
      const children = kind === '%' ? count * 2 : count; // RESP3 map = count pairs
      let cursor = eol + 1;
      const items = [];
      for (let i = 0; i < children; i += 1) {
        const inner = this.parseNested(buffer.subarray(cursor));
        if (inner === null) return null;
        items.push(inner.value);
        cursor += inner.consumed;
      }
      return { consumed: cursor, value: kind === '%' ? { t: 'map', items } : { t: 'array', items } };
    }
    throw new Error(`unexpected nested reply byte ${kind}`);
  }

  close() {
    this.socket.end();
  }
}

/** RESP map ({t:'map'}) → plain object. */
function mapOf(reply) {
  const map = {};
  for (let i = 0; i < reply.items.length; i += 2) {
    map[reply.items[i].v] = reply.items[i + 1].v;
  }
  return map;
}

/** Standard test harness bits shared by both wire suites. */
function makeSuite(printer = console) {
  const passed = [];
  let failed = false;
  const step = async (name, fn) => {
    try {
      await fn();
      passed.push(name);
      printer.log(`ok - ${name}`);
    } catch (err) {
      failed = true;
      printer.error(`not ok - ${name}`);
      printer.error(`    ${err.message}`);
      const logs = global.__gwLog || [];
      if (logs.length > 0) printer.error(`    [gateway log tail]\n      ${logs.slice(-12).join('\n      ')}`);
      const raw = global.__raw || [];
      if (raw.length > 0) printer.error(`    [wire raw tail]\n      ${raw.slice(-6).join(' | ')}`);
    }
  };
  return { step, passed, get failed() { return failed; } };
}

module.exports = { Wire, mapOf, makeSuite };
