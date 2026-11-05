/**
 * /docs — documentation overview. Split from the old single-page manual:
 * this hub stays short, and every deep topic gets its own page.
 */

import Link from 'next/link';
import { Icon } from '../../../components/common/Icon.jsx';
import DocsPager from '../../../components/docs/DocsPager.jsx';
import { ConnectionString, DocGrid, DocCard, Callout } from '../../../components/docs/DocsShared.jsx';
import { DOCS_PAGES, docsHref } from '../../../content/docs/index.js';
import { API_EXAMPLE_ORIGIN } from '../../../utils/config.js';

export const metadata = {
  description: 'What Cacheify is, how to connect, and where every guide lives.',
};

export default function DocsOverviewPage() {
  const cards = DOCS_PAGES.filter((page) => page.slug);

  return (
    <>
      <header className="docs-head">
        <p className="dash-eyebrow">
          <span className="dot" aria-hidden="true" />
          Documentation
        </p>
        <h1>Cacheify docs</h1>
        <p>
          Cacheify hosts isolated Redis-compatible databases. You keep your data
          behind scoped API keys, and the platform enforces permissions, quotas
          and expiry before a command ever runs.
        </p>
        <div className="docs-meta">
          <span><Icon name="cable" /> One connection string</span>
          <span><Icon name="cable" /> RESP gateway</span>
          <span><Icon name="key" /> Scoped keys</span>
          <span><Icon name="clock" /> Mandatory TTL</span>
        </div>
      </header>

      <section className="docs-section" id="use-it">
        <h2><Icon name="info-circle" />Connect your app</h2>
        <p>
          One credential, one line. Point any native Redis client — redis-cli,
          ioredis, redis-py, Jedis, Lettuce, Spring RedisTemplate — at:
        </p>
        <ConnectionString />
        <Callout title="Your key is the password slot.">
          Replace <code>&lt;your-key&gt;</code> with the database&apos;s active{' '}
          <code>rk_</code> key — shown once when you mint it in the dashboard.
          Keep it server-side; it is database access, not a UI token. Your
          client never needs anything else: the database, its permissions and
          its TTL policy all travel with that key.
        </Callout>
        <p>
          Behind the scenes the gateway verifies the key, enforces the same
          command surface and quotas as the dashboard Console, and stamps every
          key into your database&apos;s sealed namespace. If you build tooling
          that prefers JSON over HTTPS, an{' '}
          <Link className="text-link" href="/docs/http-data-plane">advanced HTTP reference</Link>{' '}
          exists — but it is never required: the Redis string above is the full
          integration.
        </p>
      </section>

      <section className="docs-section" id="guides">
        <h2><Icon name="book" />The guides</h2>
        <DocGrid>
          {cards.map((page) => (
            <DocCard key={page.slug} href={docsHref(page)} icon={page.icon} title={page.nav}>
              {page.lede}
            </DocCard>
          ))}
        </DocGrid>
      </section>

      <section className="docs-section" id="machines">
        <h2><Icon name="robot" />Reading it with agents or tooling</h2>
        <p>
          For code assistants and automation, point tools at the machine-readable
          surfaces instead of these pages: <code>llms.txt</code> for the short
          index and <code>openapi.json</code> for the full OpenAPI 3.1 contract.
        </p>
        <p>
          <Link className="text-link" href={`${API_EXAMPLE_ORIGIN}/llms.txt`}>
            <Icon name="robot" /> llms.txt index
          </Link>
          {' '}
          <Link className="text-link" href={`${API_EXAMPLE_ORIGIN}/api/openapi.json`}>
            <Icon name="braces" /> OpenAPI 3.1 spec
          </Link>
        </p>
      </section>

      <DocsPager slug="" />
    </>
  );
}
