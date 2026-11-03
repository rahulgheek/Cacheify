/**
 * Engineering notes published at /blog.
 *
 * These are implementation notes for the platform as it exists in this
 * repository. They deliberately avoid launch metrics, benchmark numbers and
 * regional availability claims that cannot be verified from the codebase.
 */

export const NOTES = [
  {
    slug: 'http-not-resp',
    title: 'Why the data plane speaks HTTP, not RESP',
    summary:
      'A cache that any runtime can reach without a Redis driver, a TCP socket or a connection pool. The trade-off is deliberate, and it changes how you should call it.',
    date: '2026-10-21',
    displayDate: 'October 21, 2026',
    readingTime: '6 min read',
    tag: 'Architecture',
    intro:
      'The first decision in Cacheify was not which Redis engine to embed. It was how an application should reach that engine. The answer here is HTTP + JSON, and it has consequences worth stating plainly.',
    sections: [
      {
        heading: 'The contract',
        paragraphs: [
          'Every data call is an HTTP request. A command endpoint accepts a command name and an argument array, then returns the same envelope as the rest of the platform: success, data and optional metadata. The command console in the dashboard calls the same endpoints your service calls.',
          'That means fetch, requests, Invoke-RestMethod and curl are enough. There is no RESP handshake, no persistent socket to keep alive between serverless invocations, and no driver version to match against the platform.',
        ],
        code: {
          label: 'One command over HTTP',
          text: `curl -X POST "$CACHEIFY_BASE_URL/api/data/$DB_ID/command" \\
  -H "Authorization: Bearer $CACHEIFY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"command":"SET","args":["session:9942","active","EX","3600"]}'`,
        },
      },
      {
        heading: 'Why not RESP',
        paragraphs: [
          'RESP is excellent when you control a long-lived process near the cache. It is awkward when the caller is an edge function, a scheduled job, a browser-backed tool or an AI agent that already knows how to make an HTTPS request and nothing else.',
          'Serving RESP over the same HTTPS surface would also mean asking every user to open an outbound TCP port, manage client libraries and reason about connection pooling - a class of support questions with nothing to do with the data model. That argument holds for the data plane, and the platform answers it honestly: the HTTP surface stays, and native clients get a separate RESP gateway on their own address.',
        ],
      },
      {
        heading: 'The trade-offs',
        paragraphs: [
          'HTTP is not a drop-in replacement for RESP, so the platform stopped pretending it could be one: native Redis clients do not talk to the HTTPS API. They get their own door - a RESP gateway whose AUTH password is your database API key (redis://:<API-key>@<gateway-host>:<port>/0). RedisTemplate, ioredis and redis-py connect unmodified to the same key space, with the same command surface and the same mandatory expiry as the HTTP plane.',
          'Blocking commands and pub/sub subscriptions do not fit either contract and stay outside the supported surface: roughly sixty Redis-compatible commands across strings, lists, sets, hashes and sorted sets, plus cursor-based key browsing. Pipelines let the HTTP plane batch up to fifty commands in one request; the RESP gateway batches consecutive pipelined reads on its own.',
        ],
        bullets: [
          'Use HTTP when the caller is short-lived, polyglot or already server-side.',
          'Use the redis:// gateway connection string when a native Redis client is the cleanest path - same credential, no HTTP bridge code.',
          'Batch with the pipeline endpoint or RESP pipelining instead of paying per command.',
        ],
      },
      {
        heading: 'Errors are part of the contract',
        paragraphs: [
          'A JSON API should fail in JSON. Validation, permission, quota and rate-limit failures all return a deterministic envelope with an error code and a message. A missing or expired key is a 404, not an empty string, so a cache miss and an outage never look the same.',
        ],
        code: {
          label: 'The failure envelope',
          text: `{
  "success": false,
  "error": {
    "code": "ERR_VALIDATION",
    "message": "body must not have additional properties"
  }
}`,
        },
      },
    ],
    takeaway:
      'HTTP keeps the integration surface small, and the RESP gateway keeps native clients first-class: two transports, one credential, the same stated boundary.',
  },
  {
    slug: 'mandatory-ttl',
    title: 'Every key expires. PERSIST is not a feature.',
    summary:
      'A cache without expiry is a database with worse tooling. Cacheify enforces a TTL on every key, defaults to 24 hours and rejects attempts to remove it.',
    date: '2026-10-14',
    displayDate: 'October 14, 2026',
    readingTime: '5 min read',
    tag: 'Product',
    intro:
      'Most Redis deployments treat expiry as optional. Cacheify treats it as a required property of every write. That is a product decision before it is a technical one.',
    sections: [
      {
        heading: 'The rule',
        paragraphs: [
          'Every key carries an expiry. A write that does not specify one receives the platform default of 24 hours. The command plane accepts EX and PX options, the string endpoint accepts expiresInMs, and the key detail response includes ttlMs so a client can show the remaining lifetime without a second call.',
          'There is no state in which a key has no expiry. PERSIST is rejected with 422, and there is no dashboard action that removes a TTL.',
        ],
        code: {
          label: 'Explicit expiry via the string endpoint',
          text: `await fetch(\`\${base}/api/data/\${dbId}/strings/otp:user@mail.com\`, {
  method: 'PUT',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ value: otpHash, expiresInMs: 300000 }),
});`,
        },
      },
      {
        heading: 'Why enforce it',
        paragraphs: [
          'A free, multi-tenant cache has a capacity problem: the most expensive key is the one nobody remembers writing. Optional expiry turns every forgotten session token, feature flag or temporary counter into permanent storage. The platform would either need aggressive manual cleanup or quietly degrade for everyone else.',
          'Mandatory expiry makes the storage bound predictable. Keys per database and value bytes are capped by quotas, and time is capped by TTL. An operator can reason about worst-case usage without auditing every tenant.',
        ],
      },
      {
        heading: 'How to work with it',
        paragraphs: [
          'Long-lived data needs an explicit expiry on each write, or a re-arm through the expire endpoint. Short-lived data should choose a TTL that matches its purpose rather than inheriting 24 hours by accident.',
          'Expiry is evaluated lazily: the first read after the deadline removes the key and returns 404. There is no client-side cleanup job to schedule.',
        ],
        bullets: [
          'Prefer the shortest TTL that still serves the use case.',
          'Re-arm with POST /keys/{key}/expire when the lifetime should extend.',
          'Handle a 404 as a normal cache miss, not an exception that breaks the request path.',
        ],
      },
      {
        heading: 'What this is not',
        paragraphs: [
          'This is not a retention policy for durable records. If a value must survive indefinitely, a cache is the wrong store. Export it to a database with its own backup and retention story rather than fighting the cache expiration model.',
        ],
      },
    ],
    takeaway:
      'The 24-hour default is a safety net, not a recommendation. The healthiest production keys usually have much shorter lifetimes.',
  },
  {
    slug: 'one-key-per-database',
    title: 'One active key per database, on purpose',
    summary:
      'Scoped keys are a blast-radius control. A database has exactly one active key, one permission level and one obvious rotation path.',
    date: '2026-10-02',
    displayDate: 'October 2, 2026',
    readingTime: '4 min read',
    tag: 'Security',
    intro:
      'API keys multiply quickly in most platforms: one per environment, one per service, one per developer, one left behind in a CI variable. Cacheify takes the opposite position.',
    sections: [
      {
        heading: 'The model',
        paragraphs: [
          'Each database has at most one active API key. The key is bound to that database and carries one permission level: read-only or read-write. Creating a second active key for the same database returns 409 ERR_CONFLICT. Rotation is revoke, then mint.',
          'The plaintext token is shown once at creation. The platform stores a hash and a short prefix for identification; it cannot recover the token later. Losing it means a rotation, not a lookup.',
        ],
        code: {
          label: 'A second key is a conflict',
          text: `{
  "success": false,
  "error": {
    "code": "ERR_CONFLICT",
    "message": "This database already has an active API key"
  }
}`,
        },
      },
      {
        heading: 'Why not many keys',
        paragraphs: [
          'Multiple keys per database are convenient, but they make revocation ambiguous. Which key is this service using? Which key leaked? Which key can be removed before the next deploy? A single active credential makes the answer concrete.',
          'It also makes permission boundaries easier to reason about. If a database needs read-only and read-write callers, the clean split is two databases, not two credentials with different powers over the same data.',
        ],
      },
      {
        heading: 'Rotation without downtime',
        paragraphs: [
          'Revocation is immediate: the next request with the old key fails with 401. To rotate safely, deploy code that can read the new token, revoke the old key, mint the replacement, then update the secret store and restart or reload the caller.',
          'Because only one key can be active, a rolling deploy cannot have two valid generations at once. Plan the cutover as a short, explicit step rather than an accidental overlap.',
        ],
        bullets: [
          'Store the plaintext in a server-side secret store, never in client code.',
          'Use read-only keys for reporting, dashboards and anything that only reads.',
          'Treat revocation as an incident response action: it is instant and irreversible.',
        ],
      },
    ],
    takeaway:
      'One key is a constraint, not an oversight. It makes the credential inventory equal the database inventory.',
  },
  {
    slug: '404-not-403',
    title: 'Cross-tenant reads return 404, not 403',
    summary:
      'Forbidden tells an attacker that a resource exists. Cacheify answers cross-tenant requests with the same 404 it uses for an unknown database.',
    date: '2026-09-24',
    displayDate: 'September 24, 2026',
    readingTime: '5 min read',
    tag: 'Security',
    intro:
      'Error codes are an information channel. A carefully chosen code can confirm the existence of a tenant, a database or a key without returning any of its data.',
    sections: [
      {
        heading: 'The rule',
        paragraphs: [
          'Every lookup is scoped to the authenticated owner. A request for a database that belongs to another account returns 404, identical to a request for a database that never existed. The platform does not distinguish "not yours" from "not found" in the response.',
          'The same principle applies to keys. A key name that exists in another tenant namespace is not observable through this account. Within your own database, a missing or expired key is also 404, which keeps the cache-miss contract simple.',
        ],
        code: {
          label: 'Both cases, same answer',
          text: `GET /api/data/rdb_someone_else/keys/session:1
Authorization: Bearer rk_your_key

404 { "success": false, "error": { "code": "ERR_NOT_FOUND" } }`,
        },
      },
      {
        heading: 'Where 403 is still correct',
        paragraphs: [
          '403 is reserved for cases where the caller already has a legitimate relationship with the resource: a read-only key attempting a write, or a key used outside the database it was minted for. Those responses tell an authenticated caller that the request was understood and refused, without revealing anything they did not already know.',
          'Admin endpoints are a separate surface. A non-admin session receives 403 because the session is valid and the role check failed. That is not tenant enumeration; the route itself is public knowledge.',
        ],
      },
      {
        heading: 'Why it matters in a cache',
        paragraphs: [
          'Cache keys often contain predictable identifiers: user IDs, session prefixes, feature names. If a cross-tenant probe returned 403 for existing databases and 404 for missing ones, an attacker could map another account\'s namespace without reading a single value.',
          'Non-disclosure is cheap to implement at the service boundary and expensive to retrofit after clients depend on richer error semantics. Doing it from the first request keeps the contract honest.',
        ],
      },
    ],
    takeaway:
      'A 404 is not a failure to authorize. It is the authorization result, expressed without leaking existence.',
  },
  {
    slug: 'console-is-a-client',
    title: 'The console is a client of the same API',
    summary:
      'There is no privileged browser backend. The dashboard reads keys and runs commands through the same data-plane service your application calls.',
    date: '2026-09-12',
    displayDate: 'September 12, 2026',
    readingTime: '4 min read',
    tag: 'Architecture',
    intro:
      'Internal tools tend to drift from the public contract. They get a private endpoint, a bypass flag or a direct database connection, and then they stop being useful as a test of the real product.',
    sections: [
      {
        heading: 'Same endpoints, different authentication',
        paragraphs: [
          'The key browser calls GET /api/data/{dbId}/keys. The command console calls POST /api/data/{dbId}/command. Key edits use the same command and pipeline endpoints, and the string form uses PUT /api/data/{dbId}/strings/{key}. The dashboard authenticates with your session token; your application authenticates with a scoped API key. Both paths land in the same service, permission checks and quota enforcement.',
          'That means a command that works in the console follows the same validation and quota rules as the same command from a server. The console is a convenience, not an escape hatch.',
        ],
      },
      {
        heading: 'Why this matters',
        paragraphs: [
          'When the browser and the SDK share one service, a bug reproduced in the console is a bug in the product path. There is no second implementation to keep in sync and no internal schema that diverges from the public one.',
          'It also keeps authorization honest. The console cannot read a database the signed-in user does not own, because the service applies the same owner lookup it applies to an API-key request. The UI never receives a broader view than the API would return.',
        ],
        bullets: [
          'The browser session is not a superuser credential for the data plane.',
          'Read-only keys and archived databases are enforced in the service, not hidden by the UI.',
          'The landing-page demo is explicitly local and labeled; it never claims to be connected.',
        ],
      },
      {
        heading: 'Where the demo stops',
        paragraphs: [
          'The marketing site includes a small command sandbox so visitors can feel the interaction model without an account. It runs entirely in the browser, resets on refresh and says so. Real commands require a verified account and a database, because a real command needs a real scoped key.',
          'Keeping that boundary visible is part of the design. A fake console that implies live execution would be worse than no console at all.',
        ],
      },
    ],
    takeaway:
      'A console is most useful when it cannot do anything your production client cannot do.',
  },
  {
    slug: 'quotas-that-roll-back',
    title: 'Quotas that roll back',
    summary:
      'Limits are checked before a write becomes visible. When a quota is exceeded, the platform restores the previous state instead of leaving a half-applied command.',
    date: '2026-08-30',
    displayDate: 'August 30, 2026',
    readingTime: '5 min read',
    tag: 'Reliability',
    intro:
      'A quota error is easy to return. The harder question is what happens to the data already written when the limit is crossed halfway through an operation.',
    sections: [
      {
        heading: 'The failure mode',
        paragraphs: [
          'Consider a pipeline that writes several keys and then exceeds the per-database key quota. A naive implementation returns ERR_QUOTA_EXCEEDED after applying the early writes, leaving the caller with a failure response and a partially mutated database.',
          'Cacheify snapshots the affected state before the operation and restores it when a quota check fails. The response is an error, and the data looks as if the command never ran.',
        ],
      },
      {
        heading: 'What is capped',
        paragraphs: [
          'The free-plan defaults are five databases per account, ten thousand keys per database and a 512 KiB maximum value. Those numbers are configurable by the operator and can be adjusted per account by an admin.',
          'Database count is checked when a database is created. Key count and total bytes are checked on writes. A command that would cross a limit is refused before the new value becomes the visible state.',
        ],
        bullets: [
          'Defaults: 5 databases, 10,000 keys per database, 512 KiB per value.',
          'Admins can raise or lower quotas for a single account.',
          'A quota failure returns 403 ERR_QUOTA_EXCEEDED and leaves the previous state intact.',
        ],
      },
      {
        heading: 'Why rollback instead of preflight only',
        paragraphs: [
          'Preflight checks are useful, but they are racy under concurrent writers: two requests can each pass a check and then both commit. Snapshot-and-restore closes that gap for the operations that need it.',
          'The trade-off is memory and latency proportional to the affected keys. That is acceptable for the command sizes the platform accepts, and it keeps the failure semantics simple: a failed write did not happen.',
        ],
      },
    ],
    takeaway:
      'A limit that leaves data half-written is not a limit. It is a source of incidents.',
  },
];

export function getNote(slug) {
  return NOTES.find((note) => note.slug === slug) || null;
}

export function getAdjacentNote(slug) {
  const index = NOTES.findIndex((note) => note.slug === slug);
  if (index === -1) return { previous: null, next: null };
  return {
    previous: NOTES[index + 1] || null,
    next: NOTES[index - 1] || null,
  };
}
