/**
 * /docs/ttl-policy — mandatory expiry: what every key gets, how to arm a
 * longer/shorter TTL, and why PERSIST does not exist here.
 */

import { Icon } from '../../../../components/common/Icon.jsx';
import DocsPager from '../../../../components/docs/DocsPager.jsx';
import { CodeBlock, DocTable, Callout } from '../../../../components/docs/DocsShared.jsx';
import { API_EXAMPLE_ORIGIN } from '../../../../utils/config.js';

export const metadata = {
  description: 'Every Cacheify key has a TTL: the 24-hour default, per-write expiry and why PERSIST is refused.',
};

const EXPIRE = `curl -X POST ${API_EXAMPLE_ORIGIN}/api/data/$DB_ID/keys/session:9942/expire \\
  -H "Authorization: Bearer $RK_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"expiresInMs":86400000}'`;

export default function TtlPolicyPage() {
  return (
    <>
      <header className="docs-head">
        <p className="dash-eyebrow">
          <span className="dot" aria-hidden="true" />
          Documentation
        </p>
        <h1>TTL policy</h1>
        <p>
          Every Cacheify key always has a TTL. &quot;No expiry&quot; is not a
          state a key can hold — forgotten keys cannot quietly accumulate on
          someone&apos;s Redis server.
        </p>
        <div className="docs-meta">
          <span><Icon name="clock" /> 24 h default</span>
          <span><Icon name="ban" /> PERSIST impossible</span>
          <span><Icon name="server" /> Server-side countdown</span>
        </div>
      </header>

      <section className="docs-section" id="default">
        <h2><Icon name="clock" />The default: 24 hours</h2>
        <p>
          Any write without an explicit expiry — plain <code>SET</code>,{' '}
          <code>INCR</code>, <code>APPEND</code>, <code>LPUSH</code>,{' '}
          <code>RPUSH</code>, <code>SADD</code>, <code>HSET</code>,{' '}
          <code>ZADD</code> — receives the platform default TTL of 24 hours,
          stamped by the server, not by your client.
        </p>
        <p>
          If a value must outlive a day, either arm <code>EX</code> /{' '}
          <code>expiresInMs</code> on the write itself, or re-arm it after:
        </p>
        <CodeBlock label="POST /keys/{key}/expire" text={EXPIRE} />
        <Callout title="expiresInMs is always milliseconds.">
          A 5-minute OTP is <code>300000</code> — the same as Redis{' '}
          <code>SET key value EX 300</code> (5 × 60 s).
        </Callout>
      </section>

      <section className="docs-section" id="semantics">
        <h2><Icon name="braces" />Rules for both transports</h2>
        <DocTable
          headers={['Request', 'Result']}
          rows={[
            ['Plain write (no expiry)', 'Stored with the 24 h default TTL'],
            ['Write with EX/PX/SETEX/PEXPIRE (gateway) or expiresInMs (HTTP)', 'Stored with exactly that TTL'],
            ['POST /keys/{key}/expire (HTTP) or EXPIRE (gateway)', 'Re-arms the TTL on an existing key'],
            ['PERSIST — both transports', 'Refused (HTTP 422 ERR_VALIDATION / Redis error reply): removing an expiry would create an immortal key'],
            ['Read of an expired key', '404 ERR_NOT_FOUND (HTTP) or nil (RESP); the key is gone server-side'],
          ]}
        />
        <p>
          The countdown lives on the server: when it reaches zero the key is
          already gone on the next read. There is no sweeper to run, no cron to
          set, no application-side expiry logic. <code>GET /keys/{'{key}'}</code>{' '}
          returns <code>ttlMs</code> so UIs can render countdowns without extra
          calls — and <code>TTL key</code> does the same over RESP.
        </p>
      </section>

      <section className="docs-section" id="verify-identity">
        <h2><Icon name="check2-circle" />Identical on both planes</h2>
        <p>
          The engine enforces these semantics before executing any command, so
          behavior is the same whether the backing store is the embedded engine
          or a real Redis server — and whether you arrived over HTTPS or RESP.
          Write your values with this in mind: countdown-style tokens that
          should outlive a day need their TTL armed explicitly, every time.
        </p>
      </section>

      <DocsPager slug="ttl-policy" />
    </>
  );
}
