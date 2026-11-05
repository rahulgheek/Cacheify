/**
 * /docs/faq — the short answers, one fact each, linking onward where useful.
 */

import { Icon } from '../../../../components/common/Icon.jsx';
import DocsPager from '../../../../components/docs/DocsPager.jsx';

export const metadata = { description: 'Frequently asked questions about connecting, keys, TTLs and the console.' };

const FAQ = [
  ['Can I connect with a real Redis client (redis-cli, ioredis, redis-py, Lettuce, Jedis, RedisTemplate)?',
   'Yes — that is what the Redis gateway is for: point the client at the one-line connection string with your database API key as the AUTH password. RESP2 and RESP3 (HELLO) both work, and the database is always 0. See the Redis gateway page.'],
  ['What is the connection string for a database?',
   'One string: redis://:<active API key>@<gateway-host>:<port>/0 — shown on the database page with a copy action. The credential in it is the database\'s active API key; the database is always 0. Any native Redis client dials it unchanged.'],
  ['Can I create a second API key for one database?',
   'No — exactly one active key per database. A second mint returns 409 ERR_CONFLICT. To rotate: revoke, then mint. Plaintext is shown exactly once and stored hashed.'],
  ['I lost my API key plaintext. Now what?',
   'Revoke it and mint a new one. The plaintext is unrecoverable by design — losing it costs you one revoke-and-replace, not your data.'],
  ['Are values just strings?',
   'The strings endpoint stores strings — JSON.stringify structures before storing. The command plane supports the wider Redis types: lists, sets, hashes and sorted sets with full engine semantics.'],
  ['Do expired keys need cleanup?',
   'No. Expiry is enforced server-side: the first read after expiry removes the key and answers 404 / nil. There is no sweeper, cron or restart logic to run.'],
  ['Does the web console use a different API?',
   'No. The console is a regular client of the same data plane your code calls — what you test in the dashboard is exactly what your app runs.'],
  ['Why is my cache data disappearing after a day?',
   'Probably not a bug: plain writes inherit the 24-hour default TTL. For data that must outlive a day, arm EX / expiresInMs on each write or re-arm with the expire endpoint. See the TTL policy page.'],
  ['Can scripts, transactions and pub/sub be used?',
   'No: EVAL, MULTI/EXEC/WATCH and SUBSCRIBE are documented platform boundaries — they conflict with per-request isolation. The verbs answer -ERR unknown command like any Redis verb a server does not know.'],
];

export default function FaqPage() {
  return (
    <>
      <header className="docs-head">
        <p className="dash-eyebrow">
          <span className="dot" aria-hidden="true" />
          Documentation
        </p>
        <h1>FAQ</h1>
        <p>Short, current answers. Anything deeper links out to the guide that owns the topic.</p>
      </header>

      <section className="docs-section" id="faq">
        <h2><Icon name="question-circle" />Frequently asked</h2>
        <div className="docs-faq">
          {FAQ.map(([question, answer]) => (
            <details key={question}>
              <summary>{question}</summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="docs-section" id="contact">
        <h2><Icon name="envelope" />Still stuck?</h2>
        <p>
          If something in these pages is unclear, wrong, or you are blocked on
          anything — write to{' '}
          <a className="text-link" href="mailto:rahulgheek2@gmail.com">rahulgheek2@gmail.com</a>
          {' '}and it gets fixed; the docs improve with every message.
        </p>
      </section>

      <DocsPager slug="faq" />
    </>
  );
}
