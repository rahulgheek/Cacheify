/**
 * /docs/quickstart — dashboard-driven onboarding: the dashboard does the
 * account, the database and the key; your project only gets one .env file.
 */

import Link from 'next/link';
import { Icon } from '../../../../components/common/Icon.jsx';
import DocsPager from '../../../../components/docs/DocsPager.jsx';
import { CodeBlock, ConnectionString, Callout } from '../../../../components/docs/DocsShared.jsx';
import { redisConnectionString } from '../../../../utils/config.js';

export const metadata = {
  description: 'Create a database in the dashboard, add one env value to your project, and connect.',
};

const ENV_BLOCK = `# .env — add this line to YOUR project (server-side only, never commit it)
# One value is the whole integration: database + key travel together in one URL.
REDIS_URL=${redisConnectionString('<your-key>')}`;

const FIRST_CHECK = `# sanity check with any Redis client you already have (optional)
redis-cli -u "$REDIS_URL" PING        # -> PONG
redis-cli -u "$REDIS_URL" SET greeting "hello world"
redis-cli -u "$REDIS_URL" GET greeting  # -> "hello world"`;

const STEPS = [
  {
    n: '01',
    icon: 'person',
    title: 'Create your account in the dashboard',
    body: 'Open the dashboard, choose Sign up, then type the 6-digit code we email you. Verification is what unlocks databases and keys — no CLI, no forms to hand-write.',
  },
  {
    n: '02',
    icon: 'database',
    title: 'Create a database from Databases',
    body: 'Click New database and give it a name. Five isolated databases are included free; each is its own keyspace.',
  },
  {
    n: '03',
    icon: 'key',
    title: 'Mint its active key on the database page',
    body: 'Open the database and create its key — choose read-only or read-write. The plaintext rk_… token is shown exactly once: paste it into the connection string now (step 04).',
  },
  {
    n: '04',
    icon: 'braces',
    title: 'Put the connection string in your project',
    body: 'Copy the one-line URL below into the .env of the service that will talk to Cacheify as REDIS_URL, and connect — your Redis client needs nothing else.',
  },
];

export default function QuickstartPage() {
  return (
    <>
      <header className="docs-head">
        <p className="dash-eyebrow">
          <span className="dot" aria-hidden="true" />
          Documentation
        </p>
        <h1>Quick start</h1>
        <p>
          The dashboard does the setup — account, database, key. Your project
          receives exactly one line, <code>REDIS_URL</code>, and from there any
          native Redis client connects as if nothing changed.
        </p>
      </header>

      <section className="docs-section" id="steps">
        <h2><Icon name="rocket_launch" />Four steps, all in the dashboard</h2>
        <ol className="docs-steps">
          {STEPS.map((step) => (
            <li key={step.n}>
              <code className="mono docs-step-number">{step.n}</code>
              <div>
                <strong>{step.title}</strong>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <Callout title="Your app never sees your account password.">
          The database&apos;s scoped key, embedded in the connection string, is
          the only credential an integration ever uses.
        </Callout>
      </section>

      <section className="docs-section" id="env">
        <h2><Icon name="braces" />The one env value your project needs</h2>
        <p>
          Create a <code>.env</code> file in the project that will use Cacheify
          and copy this line — only the key slot changes. No SDK ships, nothing
          to configure beyond the Redis driver you likely already use.
        </p>
        <CodeBlock label=".env — the whole integration in one value (server-side only)" text={ENV_BLOCK} />
        <ul>
          <li><code>REDIS_URL</code> — the full connection: gateway host, port and database in one URL, with your active key as the password slot.</li>
          <li>Every client that speaks Redis loads it straight in: <code>redis-cli -u</code>, ioredis, redis-py <code>from_url</code>, Jedis/Lettuce URI config, Spring RedisTemplate.</li>
          <li>Server-side only: this string is database-wide access within the key&apos;s permission — never ship it to a browser, never commit it, never log it.</li>
        </ul>
      </section>

      <section className="docs-section" id="connect">
        <h2><Icon name="cable" />The connection string, one line</h2>
        <ConnectionString />
        <p>
          Optional sanity check once <code>REDIS_URL</code> is in place:
        </p>
        <CodeBlock label="Optional sanity check (PING, SET, GET)" text={FIRST_CHECK} />
        <Callout kind="warn" title="The key is shown exactly once.">
          Keys are stored hashed. If you lose the plaintext, revoke the key on
          the database page and mint a new one — then update your{' '}
          <code>REDIS_URL</code>.
        </Callout>
      </section>

      <section className="docs-section" id="next">
        <h2><Icon name="book" />What to read next</h2>
        <p>
          The{' '}
          <Link className="text-link" href="/docs/redis-gateway">Redis gateway guide</Link>{' '}
          covers AUTH semantics, the supported verb surface and TLS. For quota
          behavior, isolation and the operator modes behind that URL, read the{' '}
          <Link className="text-link" href="/docs/architecture">architecture page</Link>.
        </p>
        <p>
          One platform rule worth knowing before you write code: every key
          expires — a plain <code>SET</code> gets a 24-hour TTL unless you ask
          for something specific. Details in the{' '}
          <Link className="text-link" href="/docs/ttl-policy">TTL policy</Link>.
        </p>
      </section>

      <DocsPager slug="quickstart" />
    </>
  );
}
