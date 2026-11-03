/**
 * Developer manual (public, viewable signed-out and signed in).
 * How Cacheify works: the REST contract, environment variables, TTL and
 * expiry semantics, framework cookbook, status codes, security, and the
 * Spring Boot RedisTemplate integration path. Every snippet mirrors the
 * behavior verified by tests/clients (7 framework clients + REST probe).
 */

import { Icon } from '../components/common/Icon.jsx';
import BackHomeButton from '../components/common/BackHomeButton.jsx';
import CopyButton from '../components/features/landing/CopyButton.jsx';
import { API_EXAMPLE_ORIGIN, redisConnectionString } from '../utils/config.js';

const ENV_BLOCK = `# .env - server-side only, never commit it
CACHEIFY_BASE_URL=${API_EXAMPLE_ORIGIN}
CACHEIFY_DB_ID=rdb_xxxxxxxx        # from the dashboard, Databases page
CACHEIFY_API_KEY=rk_xxxxxxxx       # from the API Keys page, shown ONCE
REDIS_URL=${redisConnectionString()}   # native Redis clients (RESP gateway)`;

const ENDPOINTS = [
  ['POST', '/api/auth/login', 'Sign in, get the session token'],
  ['POST', '/api/auth/otp/request', 'Send the email-verification code (new accounts must verify)'],
  ['POST', '/api/auth/otp/verify', 'Verify the 6-digit code, unlock databases/keys/data plane'],
  ['GET', '/api/profile', 'Your saved profile data (MongoDB-backed)'],
  ['PUT', '/api/profile', 'Save profile data {"displayName","bio","avatarColor"}'],
  ['GET', '/api/databases', 'List your databases'],
  ['POST', '/api/databases/{dbId}/api-keys', 'Mint THIS database\'s API key (plaintext returned once)'],
  ['GET', '/api/databases/{dbId}/api-key', 'Current active key for a database (or null)'],
  ['POST', '/api/api-keys', 'Mint a scoped key by databaseId (plaintext once)'],
  ['DELETE', '/api/api-keys/{id}', 'Revoke a key (immediate, next call 401)'],
  ['POST', '/api/data/{dbId}/command', 'Run one Redis command'],
  ['POST', '/api/data/{dbId}/pipeline', 'Atomic batch of 1-50 commands'],
  ['GET', '/api/data/{dbId}/keys?pattern=&cursor=', 'Browse keys (cursor paging)'],
  ['GET', '/api/data/{dbId}/keys/{key}', 'Key detail: value + ttlMs'],
  ['PUT', '/api/data/{dbId}/strings/{key}', 'Save a string, optional expiresInMs'],
  ['DELETE', '/api/data/{dbId}/keys/{key}', 'Delete a key'],
  ['POST', '/api/data/{dbId}/keys/{key}/expire', 'Re-arm a TTL (expiresInMs)'],
  ['GET', '/api/openapi.json', 'Machine-readable OpenAPI 3.1 contract'],
];

const HTTP_CURL = `curl -X PUT "${API_EXAMPLE_ORIGIN}/api/data/$DB_ID/strings/otp%3Auser%40mail.com" \\
  -H "Authorization: Bearer $RK_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"value":"<otp-hash>","expiresInMs":300000}'`;

const HTTP_PYTHON = `import os, requests

base = os.environ["CACHEIFY_BASE_URL"]
auth = {"Authorization": "Bearer " + os.environ["CACHEIFY_API_KEY"]}

# save with a 5-minute TTL
requests.put(f"{base}/api/data/{os.environ['CACHEIFY_DB_ID']}/strings/otp:user@mail.com",
             headers=auth, json={"value": otp_hash, "expiresInMs": 300000})

# read back: value + remaining TTL in one call
detail = requests.get(f"{base}/api/data/{os.environ['CACHEIFY_DB_ID']}/keys/otp:user@mail.com",
                      headers=auth).json()
value, ttl_ms = detail["data"]["key"]["value"], detail["data"]["key"]["ttlMs"]`;

const HTTP_NODE = `const base = process.env.CACHEIFY_BASE_URL;
const auth = { Authorization: \`Bearer \${process.env.CACHEIFY_API_KEY}\` };

// save with a 5-minute TTL
await fetch(\`\${base}/api/data/\${process.env.CACHEIFY_DB_ID}/strings/otp:user@mail.com\`, {
  method: 'PUT',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ value: otpHash, expiresInMs: 300000 }),
});

// read back
const { key } = await (await fetch(
  \`\${base}/api/data/\${process.env.CACHEIFY_DB_ID}/keys/otp:user@mail.com\`,
  { headers: auth },
)).json();  // key.value, key.ttlMs  (404 when absent or expired)`;

const SPRING_CLASS = `package com.whyql.whyql.auth.store;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Repository;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestTemplate;

/**
 * Same OtpStore interface, Cacheify over HTTP instead of the Redis protocol.
 * storeOtpHash  -> PUT    /api/data/{dbId}/strings/{key}  (expiresInMs)
 * getOtpHash    -> GET    /api/data/{dbId}/keys/{key}     (value + ttlMs)
 * deleteOtpHash -> DELETE /api/data/{dbId}/keys/{key}
 */
@Repository
public class HttpOtpStore implements OtpStore {

  private static final Duration TTL = Duration.ofMinutes(5); // expires_in 300000 ms
  private static final String PREFIX = "whyql:otp:";

  private final RestTemplate http;
  private final String baseUrl;
  private final String dbId;
  private final String apiKey;

  public HttpOtpStore(RestTemplate cacheifyRestTemplate,
                      @Value("\${cacheify.base-url}") String baseUrl,
                      @Value("\${cacheify.database-id}") String dbId,
                      @Value("\${cacheify.api-key}") String apiKey) {
    this.http = cacheifyRestTemplate;
    this.baseUrl = baseUrl;
    this.dbId = dbId;
    this.apiKey = apiKey;
  }

  @Override
  public void storeOtpHash(String email, String otpHash) {
    http.exchange(url("strings", email), HttpMethod.PUT,
        json(Map.of("value", otpHash, "expiresInMs", TTL.toMillis())), String.class);
  }

  @Override
  public Optional<String> getOtpHash(String email) {
    try {
      @SuppressWarnings("unchecked")
      Map<String, Object> env = http.getForObject(url("keys", email), Map.class);
      Map<String, Object> data = (Map<String, Object>) env.get("data");
      Map<String, Object> key = (Map<String, Object>) data.get("key");
      return Optional.ofNullable((String) key.get("value"));
    } catch (HttpStatusCodeException expiredOrMissing) {
      return Optional.empty();     // 404: never issued, consumed, or expired
    }
  }

  @Override
  public void deleteOtpHash(String email) {
    http.exchange(url("keys", email), HttpMethod.DELETE, json(null), String.class);
  }

  private String url(String resource, String email) {
    return baseUrl + "/api/data/" + dbId + "/" + resource + "/"
        + URLEncoder.encode(PREFIX + email.toLowerCase(), StandardCharsets.UTF_8);
  }

  private static HttpEntity<Map<String, Object>> json(Map<String, Object> body) {
    HttpHeaders headers = new HttpHeaders();
    headers.set("Authorization", "Bearer " + apiKey);
    headers.set("Content-Type", "application/json");
    return new HttpEntity<>(body, headers);
  }
}`;

const SPRING_CONFIG = `# application.properties (values come from the environment, never hardcoded)
cacheify.base-url=\${CACHEIFY_BASE_URL:${API_EXAMPLE_ORIGIN}}
cacheify.database-id=\${CACHEIFY_DB_ID:}
cacheify.api-key=\${CACHEIFY_API_KEY:}`;

const SPRING_BEAN = `@Bean
RestTemplate cacheifyRestTemplate() {
  var factory = new SimpleClientHttpRequestFactory();
  factory.setConnectTimeout(5_000);
  factory.setReadTimeout(10_000);
  return new RestTemplate(factory);
}`;

/* RESP gateway snippets — native Redis clients, same key as the bearer token. */
const REDIS_SNIPPETS = [
  {
    label: 'redis-cli',
    text: `# $REDIS_URL = the redis:// connection string from the database page
redis-cli -u "$REDIS_URL" SET greeting hello
redis-cli -u "$REDIS_URL" GET greeting
redis-cli -u "$REDIS_URL" SET otp:user@mail.com <otp-hash> EX 300`,
  },
  {
    label: 'Node.js (ioredis)',
    text: `const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

await redis.set('greeting', 'hello');                  // inherits the 24h default TTL
await redis.get('greeting');                           // "hello"
await redis.setex('otp:user@mail.com', 300, otpHash);  // explicit 5 minutes`,
  },
  {
    label: 'Python (redis-py)',
    text: `import os, redis

conn = redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True)

conn.set("greeting", "hello")                          # inherits the 24h default TTL
conn.get("greeting")
conn.setex("otp:user@mail.com", 300, otp_hash)         # explicit 5 minutes`,
  },
];

const ERRORS = [
  ['401', 'ERR_UNAUTHORIZED', 'Missing / invalid / revoked token. Revoked keys fail with exactly this.'],
  ['403', 'ERR_FORBIDDEN', 'Permission denied: read-only key used for a write, or a key outside its database.'],
  ['403', 'ERR_QUOTA_EXCEEDED', 'Plan quota reached (databases, keys, or bytes).'],
  ['404', 'ERR_NOT_FOUND', 'Unknown or expired key / database. Treat as a miss, like Redis nil.'],
  ['409', 'ERR_CONFLICT', 'A resource rule was hit - typically minting a second key for a database that already has one active.'],
  ['413', 'ERR_PAYLOAD_TOO_LARGE', 'Value above the account limit.'],
  ['422', 'ERR_VALIDATION', 'Strict body validation: wrong field, wrong type, unknown extra field.'],
  ['429', 'ERR_RATE_LIMITED', 'Too many requests; back off and retry.'],
  ['503', 'ERR_SERVICE_UNAVAILABLE', 'Backing Redis unreachable; retry with backoff.'],
];

const FAQ = [
  ['Can I connect with a Redis client (redis://, ioredis, redis-py, Lettuce, StringRedisTemplate)?',
   'Yes. Native clients speak RESP over TCP, and Cacheify runs a RESP gateway on a dedicated address for exactly that: connect to the redis:// connection string with your database API key as the AUTH password. RESP2 and RESP3 (HELLO 3) both work, the database is always db 0, and SET, INCR, EXPIRE and friends behave like real Redis. The HTTP/JSON data plane below remains the better fit for serverless and edge callers.'],
  ['Can I create a second API key for one database?',
   'No - a database has exactly one active API key at a time. A second creation attempt returns 409 ERR_CONFLICT. To rotate: revoke the existing key, then mint a new one (the database page and the API keys page both manage this).'],
  ['What is the connection string for a database?',
   'Two, one per transport, both shown on the database page with copy actions. Redis clients: redis://:<active API key>@<gateway-host>:<port>/0 - the key is the password slot and the database is always 0. HTTP callers: {BASE}/api/data/{dbId} - all data calls live under it (strings/, keys/, expire, command). The credential in both is the same single active API key.'],
  ['Are values just strings?',
   'The strings endpoint stores strings; JSON.stringify structures before storing and parse after reading. The command plane supports the wider Redis types with full engine semantics.'],
  ['I lost the API key plaintext. Now what?',
   'Revoke it from the API Keys page and mint a new one. Plaintext is shown exactly once at creation, stored hashed, and never recoverable - by design.'],
  ['Do expired keys need cleanup?',
   'No. Expiry is enforced server-side: the first read after expiry removes the key and answers 404 / null. Delete-then-expire TTL endpoints handle the rare manual cases.'],
  ['Does the web console use a different API?',
   'No - the console is a regular client of the same data plane you call from code. What you test in the console is exactly what your app runs.'],
];

/* ------------------------------------------------------------------ */

const SECTIONS = [
  {
    icon: 'info-circle',
    title: 'What Cacheify is',
    body: [
      'Cacheify is a hosting front-end for Redis: sign up, create isolated logical databases, and work with their keys from the web UI or from any HTTP client using scoped API keys. Quotas, permissions (read-only / read-write), rate limits and an audit log are enforced by the platform before a command ever touches Redis.',
      'The data plane runs either on the platform\'s embedded dev engine or directly against a real Redis server the operator configured. In both modes the client-facing contract is identical HTTP + JSON.',
    ],
  },
  {
    icon: 'terminal',
    title: 'Two ways in: HTTPS data plane or RESP gateway',
    body: [
      'The data plane speaks HTTP/JSON on an HTTPS port. Any HTTP client - fetch, requests, RestTemplate, Invoke-RestMethod, curl - is your Redis client against /api/data/{dbId}. This is why the same call works identically from seven different ecosystems; the tests folder in the repository proves it live, framework by framework.',
      'Native Redis clients (redis-cli, ioredis, redis-py, go-redis, Jedis, Lettuce, Spring\'s RedisTemplate) open a raw TCP socket and speak RESP instead. For them the platform runs a dedicated RESP gateway: point the client at the redis:// connection string with your database API key as the AUTH password, and your existing code works unchanged. Same key, same command surface, same mandatory TTL policy - the section below shows how.',
    ],
  },
  {
    icon: 'cable',
    title: 'Connect with a native Redis client (RESP gateway)',
    body: [
      'The RESP gateway exposes this same key space over the Redis wire protocol on its own address, separate from the HTTPS API. The AUTH password is exactly the database\'s active API key - the same rk_ token the HTTP plane uses - verified on the first data command: a dead key answers -NOAUTH and the socket closes, like a wrong password.',
      'REDIS_URL holds the connection string; the password slot is the active API key and the database is always 0. Set NEXT_PUBLIC_GATEWAY_URL on the frontend deployment to your deployed gateway endpoint to swap the placeholder.',
    ],
    code: REDIS_SNIPPETS,
    list: [
      'Anything that speaks RESP2 or RESP3 connects: redis-cli, ioredis, redis-py, go-redis, Jedis, Lettuce. HELLO 3 upgrades the connection protocol transparently.',
      'SELECT 0 only: one Cacheify database is one virtual Redis database, fixed by the AUTH key.',
      'Same command surface and TTL policy as the HTTP plane - strings, counters, hashes, lists, sets, sorted sets. EX, SETEX, EXPIRE and PEXPIRE arm real server-side TTLs; plain writes inherit the 24-hour platform default.',
      'KEYS and SCAN patterns are namespace-scoped automatically (KEYS is served over a bounded SCAN loop, never a blocking full-keyspace scan).',
      'Unsupported verbs (MULTI/EXEC, BLPOP/BRPOP, SUBSCRIBE) answer exactly like Redis: -ERR unknown command, no partial execution.',
      'Pipelines behave like sequential execution, and 3+ consecutive batchable reads collapse into one internal round-trip.',
    ],
  },
  {
    icon: 'key',
    title: 'Quick start in four calls',
    list: [
      'Register: POST /api/auth/register {"email":"...","password":"..."} - then login the same way; the session token comes back in data.token.',
      'Create a database: POST /api/databases {"name":"my-db"} - you get up to five, each fully isolated and capped by quotas.',
      'Mint a scoped key: POST /api/databases/{dbId}/api-keys {"name":"my-app","permission":"read-write"} - the plaintext (rk_...) is shown once; store it in your server\'s .env. Exactly one active key per database: revoke the current key first to mint a replacement.',
      'Use the data plane with only that key: the connection string is {BASE}/api/data/{dbId} - PUT /strings/..., GET /keys/..., as shown in the next sections. Your app never needs your account password. Prefer a native Redis client? Skip straight to the RESP gateway section - it consumes the same key over the wire protocol.',
    ],
  },
  {
    icon: 'gear',
    title: 'Environment reference (.env)',
    body: [
      'Three values go into the server that calls the platform. Nothing else is required; no SDK ships, no client library to install.',
    ],
    code: [{ label: '.env (server-side only)', text: ENV_BLOCK }],
    list: [
      'Server-side only: the API key is database-wide access for its scope. Never ship it to a browser, never commit it, never log it.',
      'The plaintext is shown exactly once at creation and stored hashed; losing it means revoking and re-minting.',
      'CACHEIFY_BASE_URL changes to your deployed origin when the platform is not on localhost.',
      'REDIS_URL is only for native Redis clients (RESP gateway): the same rk_ key is the password slot. Skip it if you only call the HTTP plane.',
    ],
  },
  {
    icon: 'database',
    title: 'Data-plane endpoint reference',
    body: [
      'Every response uses the envelope {"success":true,"data":...} or {"success":false,"error":{"code":"ERR_...","message":"..."}}. Redis nil is represented as null; missing or expired keys surface as 404.',
    ],
    table: ENDPOINTS,
  },
  {
    icon: 'clock',
    title: 'TTL and expiry semantics',
    list: [
      'MANDATORY EXPIRY: every key always has a TTL - "no expiry" is not a state a key can be in. Writes without an explicit expiry (plain SET, INCR, APPEND, LPUSH, RPUSH, SADD, HSET, ZADD) receive the platform default TTL of 24 hours.',
      'Keep an eye on countdown-style data you intend to last longer than a day: either set an explicit expiresInMs / EX on each write, or re-arm with POST /keys/{key}/expire.',
      'expiresInMs is always MILLISECONDS: a 5-minute OTP lives for 300000 ms, exactly like Redis "SET key val EX 300" in the command plane.',
      'The countdown lives on the server. After it reaches zero the first read deletes the key and answers 404 ERR_NOT_FOUND - no sweeper jobs, no cron, no application restart logic.',
      'GET /keys/{key} returns ttlMs so you can show countdowns without extra calls.',
      'POST /keys/{key}/expire re-arms a TTL on an existing key. PERSIST is disabled (422): removing an expiry would create an immortal key.',
      'These semantics are identical in the embedded engine and against a real backing Redis - verified live by the framework test kit.',
    ],
  },
  {
    icon: 'braces',
    title: 'Framework cookbook',
    body: [
      'Save an OTP-shaped value with a 5-minute TTL, then read it back - the two calls an auth flow needs. Snippets are exercised daily by the repository\'s test clients.',
    ],
    code: [
      { label: 'cURL', text: HTTP_CURL },
      { label: 'Python (requests)', text: HTTP_PYTHON },
      { label: 'Node.js (native fetch)', text: HTTP_NODE },
    ],
  },
  {
    icon: 'braces',
    title: 'Spring Boot: keep your RedisTemplate code, bridge the transport',
    body: [
      'Spring\'s StringRedisTemplate speaks the Redis protocol over TCP, so it has two Cacheify paths. The direct one: point spring.data.redis.url at the gateway connection string (REDIS_URL above) - the password slot is your API key, and RedisTemplate, Jedis and Lettuce all work against Cacheify with zero code changes.',
      'The HTTP bridge below is the second path - the clean fit for callers that cannot hold a persistent socket (serverless functions, restricted egress, one-shot jobs). Because your persistence layer hides behind the OtpStore interface, autowire one or the other by configuration; your service layer never learns the difference. Both paths land in the same database with the same TTL policy.',
    ],
    code: [
      { label: 'application.properties', text: SPRING_CONFIG },
      { label: 'RestTemplate bean (any @Configuration class)', text: SPRING_BEAN },
      { label: 'HttpOtpStore.java', text: SPRING_CLASS },
    ],
    list: [
      'Expires after exactly 5 minutes, enforced server-side - same as opsForValue().set(key, hash, TTL).',
      'getOtpHash: 404 (expired, consumed, or never issued) maps to Optional.empty() - identical behavior to a Redis nil read.',
      'URL-encode the key name (URLEncoder covers ":" and "@" in e-mails).',
      'Keep the API key in application.properties sourced from environment variables, and use a read-write key scoped to this database only.',
      'Traffic between your service and Cacheify stays internal: no key material in logs, no plaintext ever shipped to clients.',
    ],
  },
  {
    icon: 'shield-lock',
    title: 'Status codes and error codes',
    table2: ERRORS,
  },
  {
    icon: 'person-circle',
    title: 'Security and operations',
    list: [
      'Keys are scoped per database and per permission level; a read-only key receives 403 on any write attempt - enforced server-side, not client-side.',
      'Revocation is immediate: the next request with a revoked key fails with 401 ERR_UNAUTHORIZED.',
      'Every request carries a request id; writes and lifecycle changes (key created / revoked, database flushed / deleted) land in the audit log.',
      'Rate limiting and quotas are server-side; 429 tells you to back off.',
      'Redis connection credentials live in the operator\'s server configuration and are never exposed to users.',
    ],
  },
  {
    icon: 'info-circle',
    title: 'Building with AI agents',
    body: [
      'The landing page ships a one-shot "AI setup prompt" (copy button included) that tells any AI assistant what to add to .env, which endpoints to call, and how TTL works. For deeper discovery, point agents at the machine-readable document: GET /llms.txt (quick index) and GET /api/openapi.json (full OpenAPI 3.1 spec). Both are fetchable and safe to hand to a coding agent.',
    ],
  },
  {
    icon: 'hand-index',
    title: 'FAQ',
    faq: FAQ,
  },
];

/* ------------------------------------------------------------------ */

const SECTION_IDS = {
  'What Cacheify is': 'overview',
  'Two ways in: HTTPS data plane or RESP gateway': 'http-contract',
  'Connect with a native Redis client (RESP gateway)': 'redis-gateway',
  'Quick start in four calls': 'quickstart',
  'Environment reference (.env)': 'environment',
  'Data-plane endpoint reference': 'endpoints',
  'TTL and expiry semantics': 'ttl-and-expiry',
  'Framework cookbook': 'cookbook',
  'Spring Boot: keep your RedisTemplate code, bridge the transport': 'spring-boot',
  'Status codes and error codes': 'errors',
  'Security and operations': 'security',
  'Building with AI agents': 'agents',
  FAQ: 'faq',
};

function CodeBlock({ label, text }) {
  return (
    <div className="docs-code">
      <div className="docs-code-head">
        <span className="docs-code-label">{label}</span>
        <CopyButton
          text={text}
          label="Copy code"
          copiedLabel="Copied"
          className="docs-copy"
          iconName="clipboard"
        />
      </div>
      <pre>{text}</pre>
    </div>
  );
}

function SectionTable({ headers, rows }) {
  return (
    <table className="docs-table">
      <thead>
        <tr>
          {headers.map((header) => (
            <th key={header} scope="col">{header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex} className={cellIndex === 1 ? 'mono' : undefined}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ManualPage() {
  return (
    <div className="docs-page">
      <aside className="docs-toc" aria-label="On this page">
        <p className="docs-toc-title">On this page</p>
        <nav>
          {SECTIONS.map((section) => (
            <a href={`#${SECTION_IDS[section.title]}`} key={section.title}>
              {section.title}
            </a>
          ))}
        </nav>
      </aside>

      <div className="docs-content">
        <header className="docs-head">
          <p className="dash-eyebrow">
            <span className="dot" aria-hidden="true" />
            Developer documentation
          </p>
          <h1>Developer manual</h1>
          <p>
            The full contract for humans: environment variables, endpoints, TTL
            semantics, native Redis clients, framework recipes (including Spring
            Boot), errors and security.
          </p>
          <div className="docs-meta">
            <span><Icon name="send" /> HTTP + JSON</span>
            <span><Icon name="cable" /> RESP gateway</span>
            <span><Icon name="key" /> Scoped bearer keys</span>
            <span><Icon name="clock" /> Mandatory TTL</span>
            <span>Last reviewed November 2026</span>
          </div>
        </header>

        {SECTIONS.map((section) => (
          <section className="docs-section" id={SECTION_IDS[section.title]} key={section.title}>
            <h2>
              <Icon name={section.icon} />
              {section.title}
            </h2>

            {(section.body || []).map((paragraph, index) => (
              <p key={`${section.title}-body-${index}`}>{paragraph}</p>
            ))}

            {section.list ? (
              <ul>
                {section.list.map((item, index) => (
                  <li key={`${section.title}-item-${index}`}>{item}</li>
                ))}
              </ul>
            ) : null}

            {(section.code || []).map((code) => (
              <CodeBlock key={code.label} label={code.label} text={code.text} />
            ))}

            {section.table ? (
              <SectionTable headers={['Method', 'Path', 'Purpose']} rows={section.table} />
            ) : null}
            {section.table2 ? (
              <SectionTable headers={['Status', 'Code', 'Meaning']} rows={section.table2} />
            ) : null}

            {section.faq ? (
              <div className="docs-faq">
                {section.faq.map(([question, answer]) => (
                  <details key={question}>
                    <summary>{question}</summary>
                    <p>{answer}</p>
                  </details>
                ))}
              </div>
            ) : null}
          </section>
        ))}

        <div className="docs-foot">
          <BackHomeButton />
          <span>Corrections welcome - every endpoint above is exercised by the API test suite.</span>
        </div>
      </div>
    </div>
  );
}
