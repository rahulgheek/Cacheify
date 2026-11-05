/**
 * /docs/redis-gateway — how to connect native Redis clients through the RESP
 * gateway. Protocol facts grounded in the official RESP specification
 * (redis.io, RESP2/RESP3, HELLO handshake, pipelining semantics).
 */

import Link from 'next/link';
import { Icon } from '../../../../components/common/Icon.jsx';
import DocsPager from '../../../../components/docs/DocsPager.jsx';
import { CodeBlock, ConnectionString, Callout, DocTable } from '../../../../components/docs/DocsShared.jsx';

export const metadata = {
  description: 'Connect redis-cli, ioredis, redis-py, Jedis or Lettuce to Cacheify over RESP.',
};

const SNIPPETS = [
  {
    label: 'redis-cli',
    text: `$REDIS_URL="redis://:<your-key>@<gateway-host>:<port>/0"

redis-cli -u "$REDIS_URL" set greeting hello         # OK — inherits 24h TTL
redis-cli -u "$REDIS_URL" get greeting               # "hello"
redis-cli -u "$REDIS_URL" set otp:user@mail.com abc EX 300`,
  },
  {
    label: 'Node.js (ioredis)',
    text: `const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

await redis.set('greeting', 'hello');                  // inherits the 24h TTL
await redis.get('greeting');                           // "hello"
await redis.setex('otp:user@mail.com', 300, otpHash);  // explicit 5 minutes`,
  },
  {
    label: 'Python (redis-py)',
    text: `import os, redis

conn = redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)

conn.set("greeting", "hello")                      # inherits the 24h TTL
conn.get("greeting")
conn.setex("otp:user@mail.com", 300, otp_hash)     # explicit 5 minutes`,
  },
];

export default function RedisGatewayPage() {
  return (
    <>
      <header className="docs-head">
        <p className="dash-eyebrow">
          <span className="dot" aria-hidden="true" />
          Documentation
        </p>
        <h1>Redis gateway</h1>
        <p>
          Standard Redis clients speak RESP, a binary-safe, request-response wire
          protocol over TCP (RESP2 by default, RESP3 via the <code>HELLO</code>{' '}
          handshake). Cacheify runs a RESP gateway so your existing Redis client
          code connects to a Cacheify database unchanged.
        </p>
        <div className="docs-meta">
          <span><Icon name="cable" /> redis:// and rediss://</span>
          <span><Icon name="check2-circle" /> RESP2 + RESP3</span>
          <span><Icon name="shield-lock" /> AUTH = API key</span>
        </div>
      </header>

      <section className="docs-section" id="connect">
        <h2><Icon name="plug" />Connect</h2>
        <p>The whole connection is one line:</p>
        <ConnectionString transport="redis" />
        <p>
          The password slot holds the database&apos;s active API key and the
          database is always <code>0</code> — <code>SELECT</code> is accepted for
          compatibility but cannot switch databases: one Cacheify database is one
          virtual Redis database, fixed by the AUTH key.
        </p>
        <Callout kind="warn" title="AUTH is lazy by design.">
          Your first data command verifies the key. A dead or revoked key answers{' '}
          <code>-NOAUTH Authentication required.</code> exactly like a wrong
          password in Redis, and closes the connection — check your key, then mint
          a fresh one in the dashboard if needed.
        </Callout>
      </section>

      <section className="docs-section" id="snippets">
        <h2><Icon name="code-slash" />First commands</h2>
        <p>The string above lives in your <code>REDIS_URL</code> environment variable:</p>
        {SNIPPETS.map((snippet) => (
          <CodeBlock key={snippet.label} label={snippet.label} text={snippet.text} />
        ))}
      </section>

      <section className="docs-section" id="behavior">
        <h2><Icon name="diagram-3" />Behavior you can rely on</h2>
        <DocTable
          headers={['Works like real Redis', 'Notes']}
          rows={[
            ['SET / GET / INCR / EXPIRE / DEL / TYPE / EXISTS / TTL …', 'Same reply shapes, same error prefixes (ERR, WRONGTYPE).'],
            ['Strings, lists, sets, hashes, sorted sets', 'Same command surface as the dashboard Console.'],
            ['Pipelining', 'Clients may send commands without waiting; replies come in order (the documented RESP request-response model).'],
            ['KEYS / SCAN', 'Bounded SCAN loop server-side — patterns never leave your tenant namespace.'],
            ['EX / SETEX / EXPIRE / PEXPIRE', 'Server arms a real TTL; writes without one inherit the 24-hour platform default.'],
          ]}
        />
      </section>

      <section className="docs-section" id="limits-not-included">
        <h2><Icon name="slash-circle" />Not supported (documented, by design)</h2>
        <ul>
          <li>
            Transactions and blocking verbs: <code>MULTI</code>/<code>EXEC</code>/{' '}
            <code>WATCH</code>, <code>BLPOP</code>/<code>BRPOP</code>/{' '}
            <code>BRPOPLPUSH</code> — these hold a long-lived session state that
            conflicts with per-request isolation and quotas. They answer{' '}
            <code>-ERR unknown command</code> with nothing executed, exactly like
            Redis does for any verb it does not know.
          </li>
          <li>
            Pub/sub: <code>SUBSCRIBE</code> — the connection would switch to the
            Redis push model, which the gateway does not forward.
          </li>
          <li>
            Lua: <code>EVAL</code> — scripts run without per-command argument
            checks.
          </li>
          <li>
            <code>PERSIST</code> — refused with an error; no key may lose its TTL
            (see the{' '}
            <Link className="text-link" href="/docs/ttl-policy">TTL policy</Link>).
          </li>
        </ul>
      </section>

      <section className="docs-section" id="tls">
        <h2><Icon name="lock" />TLS (rediss://)</h2>
        <p>
          The gateway serves plain <code>redis://</code>; when the operator
          installs a certificate pair it speaks <code>rediss://</code>. Nothing
          changes in your client code except the scheme in the connection
          string.
        </p>
      </section>

      <DocsPager slug="redis-gateway" />
    </>
  );
}
