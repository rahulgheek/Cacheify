/**
 * /docs/errors — the error contract: status codes, error codes, retry rules.
 */

import Link from 'next/link';
import { Icon } from '../../../../components/common/Icon.jsx';
import DocsPager from '../../../../components/docs/DocsPager.jsx';
import { DocTable, Callout } from '../../../../components/docs/DocsShared.jsx';

export const metadata = {
  description: 'Every status and error code Cacheify returns, and how to retry safely.',
};

const CODES = [
  ['401', 'ERR_UNAUTHORIZED', 'Missing, invalid or revoked token. Revoked keys fail with exactly this — mint a new key.'],
  ['403', 'ERR_FORBIDDEN', 'Permission denied: a read-only key sent a write, or a key was used outside its database.'],
  ['403', 'ERR_QUOTA_EXCEEDED', 'Plan limit reached (databases, keys or bytes). Clean up or expect the admin to raise the ceiling.'],
  ['404', 'ERR_NOT_FOUND', 'Unknown or expired key / unknown database. Treat as a miss — same semantics as Redis nil.'],
  ['409', 'ERR_CONFLICT', 'Rule collision — typically minting a second key for a database that already has one active.'],
  ['413', 'ERR_PAYLOAD_TOO_LARGE', 'Value above the value-size quota.'],
  ['422', 'ERR_VALIDATION', 'Strict body validation: wrong field, wrong type, unknown extra field. Fix the payload shape.'],
  ['429', 'ERR_RATE_LIMITED', 'Too many requests. Read Retry-After, back off, retry with jitter.'],
  ['503', 'ERR_SERVICE_UNAVAILABLE', 'Backing store unreachable. Retry with exponential backoff.'],
];

export default function ErrorsPage() {
  return (
    <>
      <header className="docs-head">
        <p className="dash-eyebrow">
          <span className="dot" aria-hidden="true" />
          Documentation
        </p>
        <h1>Errors</h1>
        <p>
          Errors are structured: <code>{'{ "success": false, "error": { "code": "ERR_…", "message": "…" } }'}</code>.
          Branch on <code>error.code</code>, never on the human message — codes
          are stable, strings are not.
        </p>
        <div className="docs-meta">
          <span><Icon name="shield-exclamation" /> stable codes</span>
          <span><Icon name="clock-history" /> retry-safe</span>
        </div>
      </header>

      <section className="docs-section" id="codes">
        <h2><Icon name="list" />The full table</h2>
        <DocTable headers={['HTTP', 'Code', 'Meaning and fix']} rows={CODES} />
      </section>

      <section className="docs-section" id="retry">
        <h2><Icon name="arrow-repeat" />Retrying without making it worse</h2>
        <ul>
          <li><strong>429 / 503</strong> are the retryable classes: honor <code>Retry-After</code>, add jitter, cap retries. Everything else means &quot;fix the request&quot;, not &quot;send it again&quot;.</li>
          <li><strong>404</strong> is a miss, not an error to escalate: a key that hit its TTL answers 404 by design (see <Link className="text-link" href="/docs/ttl-policy">TTL policy</Link>).</li>
          <li><strong>Writes</strong> are atomic over pipelines — a rejected batch leaves no partial state, so re-sending a failed batch is always safe.</li>
          <li><strong>429 flood guard</strong>: per-database in-flight caps reject instantly rather than queueing; keep small client connection pools instead of one giant unbounded fan-out.</li>
        </ul>
        <Callout kind="warn" title="RESP errors keep Redis shape too.">
          Over the gateway, errors arrive as RESP error replies with their
          standard prefix — <code>-NOAUTH</code> for a dead key,{' '}
          <code>-WRONGTYPE</code> for a type mismatch, <code>-ERR</code> for
          unknown verbs — so standard client libraries raise their normal
          exceptions.
        </Callout>
      </section>

      <DocsPager slug="errors" />
    </>
  );
}
