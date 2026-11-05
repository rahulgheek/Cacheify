/**
 * /docs/architecture — the request path, tenant isolation, quotas and the two
 * operator data-plane modes. The extended version of the homepage
 * infrastructure story, without marketing.
 */

import Link from 'next/link';
import { Icon } from '../../../../components/common/Icon.jsx';
import DocsPager from '../../../../components/docs/DocsPager.jsx';
import { DocTable, Callout } from '../../../../components/docs/DocsShared.jsx';

export const metadata = {
  description: 'How a request travels: auth, quotas, namespace isolation, and operator data-plane modes.',
};

export default function ArchitecturePage() {
  return (
    <>
      <header className="docs-head">
        <p className="dash-eyebrow">
          <span className="dot" aria-hidden="true" />
          Documentation
        </p>
        <h1>Architecture</h1>
        <p>
          One request path, two ways to store data. The platform checks auth,
          permissions, verification, rate limits and quotas on every request
          before the command ever reaches a store.
        </p>
        <div className="docs-meta">
          <span><Icon name="diagram-3" /> Request path</span>
          <span><Icon name="lock" /> Isolation</span>
          <span><Icon name="sliders" /> Quotas</span>
        </div>
      </header>

      <section className="docs-section" id="path">
        <h2><Icon name="arrow-right-circle" />The path of a request</h2>
        <ol>
          <li>
            <strong>Transport.</strong> Your client speaks HTTPS (HTTP plane) or
            RESP over TCP (gateway). Both end into the same API: the gateway
            translates each Redis command into an authenticated REST call.
          </li>
          <li>
            <strong>Identity.</strong> <code>attachUser</code> resolves your
            credential — a browser session token or an <code>rk_</code> API key.
            An API key pins the request to exactly one database and one
            permission level (read-only or read-write).
          </li>
          <li>
            <strong>Checks.</strong> Email verification for new accounts, CORS for
            browsers, body-size limits, per-database concurrency caps, then rate
            limits — <code>429</code> + <code>Retry-After</code> instead of
            queueing.
          </li>
          <li>
            <strong>Execution.</strong> The command is validated against the
            engine registry and executed in your tenant namespace; writes carry
            their TTL (mandatory, default 24 h).
          </li>
          <li>
            <strong>Reply.</strong> A uniform <code>{'{ success, data, meta }'}</code>{' '}
            envelope, with timing surfaced in <code>Server-Timing</code> on every
            response.
          </li>
        </ol>
      </section>

      <section className="docs-section" id="isolation">
        <h2><Icon name="lock" />Tenant isolation</h2>
        <ul>
          <li>
            Every database is a sealed namespace on the backing store. Keys are
            rewritten to <code>rh:&lt;namespace&gt;:&lt;key&gt;</code> at the
            boundary and stripped again on the way back — cross-tenant reads are
            structurally impossible, not forbidden-by-convention.
          </li>
          <li>
            A read-only key that attempts any write gets <code>403 ERR_FORBIDDEN</code>{' '}
            before the command executes.
          </li>
          <li>
            Exactly one active API key per database; a second mint attempt
            returns <code>409 ERR_CONFLICT</code> (revoke, then re-mint to rotate).
          </li>
          <li>
            Another account&apos;s unknown database returns the same 404 contract
            as a missing key — the API never confirms other tenants exist.
          </li>
        </ul>
      </section>

      <section className="docs-section" id="quotas">
        <h2><Icon name="sliders" />Quotas that hold</h2>
        <DocTable
          headers={['Limit', 'Free-plan default', 'Behavior beyond the limit']}
          rows={[
            ['Databases per account', '5', 'Creation refused with ERR_QUOTA_EXCEEDED'],
            ['Keys per database', '10,000', 'Write refused; nothing partially stored'],
            ['Value size per key', '512 KiB', '413 ERR_PAYLOAD_TOO_LARGE'],
            ['Admin-raised ceilings', 'Adjustable per account', 'Admins can search accounts and tune limits'],
          ]}
        />
        <Callout title="Over-quota is atomic.">
          Quota failures restore the pre-command state — a rejected write never
          leaves half-loaded data behind.
        </Callout>
      </section>

      <section className="docs-section" id="modes">
        <h2><Icon name="hdd-network" />Operator data-plane modes</h2>
        <p>The client contract never changes; the backing store does:</p>
        <DocTable
          headers={['Mode', 'Backing store', 'Notes']}
          rows={[
            ['Embedded (default)', 'The platform engine itself', 'Zero configuration; same command surface'],
            ['Remote (optional)', 'A real Redis server the operator configures', 'Connection lives server-side only; every DB becomes a namespaced tenant on that server'],
          ]}
        />
        <p>
          Server-side details (the TLS CA file, connection string, sweep loop)
          stay in the operator&apos;s environment and are never exposed to
          consumers — no API response, log line or docs page carries them.
        </p>
      </section>

      <section className="docs-section" id="security">
        <h2><Icon name="shield-lock" />Security and operations</h2>
        <ul>
          <li>Keys are stored hashed; plaintext is shown exactly once at mint time.</li>
          <li>Revocation is immediate — the next request with a revoked key fails with 401 ERR_UNAUTHORIZED.</li>
          <li>Every request carries a request id; key and database lifecycle changes land in the audit log.</li>
          <li>Every write requires an expiry — forgotten keys cannot become silent storage costs (see {' '}
            <Link className="text-link" href="/docs/ttl-policy">TTL policy</Link>).</li>
          <li>Rate-limit windows and quota counters are server-side; clients see only the 429 contract.</li>
        </ul>
      </section>

      <DocsPager slug="architecture" />
    </>
  );
}
