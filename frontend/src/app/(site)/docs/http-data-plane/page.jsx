/**
 * /docs/http-data-plane — every REST surface of the data plane: envelope,
 * endpoints, pipelines, framework cookbook and the Spring HTTP bridge.
 */

import Link from 'next/link';
import { Icon } from '../../../../components/common/Icon.jsx';
import DocsPager from '../../../../components/docs/DocsPager.jsx';
import { CodeBlock, Callout, DocTable } from '../../../../components/docs/DocsShared.jsx';
import { API_EXAMPLE_ORIGIN } from '../../../../utils/config.js';

export const metadata = {
  description: 'The JSON/HTTPS contract: endpoints, envelope, pipeline and value size rules.',
};

const ENDPOINTS = [
  ['POST', '/api/data/{dbId}/command', 'Run one Redis command {"command","args"}'],
  ['POST', '/api/data/{dbId}/pipeline', 'Atomic batch of 1-50 commands [{"command","args"}]'],
  ['GET', '/api/data/{dbId}/keys?pattern=&cursor=', 'Browse keys (cursor paging)'],
  ['GET', '/api/data/{dbId}/keys/{key}', 'Key detail: value + ttlMs (404 = absent or expired)'],
  ['PUT', '/api/data/{dbId}/strings/{key}', 'Save a string {"value","expiresInMs"?}'],
  ['DELETE', '/api/data/{dbId}/keys/{key}', 'Delete a key'],
  ['POST', '/api/data/{dbId}/keys/{key}/expire', 'Re-arm a TTL {"expiresInMs"}'],
  ['POST', '/api/data/{dbId}/rate-limit', 'Rate-limit probe for client feedback'],
];

const CURL = `curl -X PUT "${API_EXAMPLE_ORIGIN}/api/data/$DB_ID/strings/session:9942" \\
  -H "Authorization: Bearer $RK_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"value":"active","expiresInMs":300000}'`;

const PYTHON = `import os, requests

base = os.environ["CACHEIFY_BASE_URL"]
auth = {"Authorization": "Bearer " + os.environ["CACHEIFY_API_KEY"]}

# save with a 5-minute TTL
requests.put(f"{base}/api/data/{os.environ['CACHEIFY_DB_ID']}/strings/session:9942",
             headers=auth, json={"value": "active", "expiresInMs": 300000})

# read back: value + remaining TTL in one call
detail = requests.get(f"{base}/api/data/{os.environ['CACHEIFY_DB_ID']}/keys/session:9942",
                      headers=auth).json()
value, ttl_ms = detail["data"]["key"]["value"], detail["data"]["key"]["ttlMs"]`;

const NODE = `const base = process.env.CACHEIFY_BASE_URL;
const auth = { Authorization: \`Bearer \${process.env.CACHEIFY_API_KEY}\` };

// save with a 5-minute TTL
await fetch(\`\${base}/api/data/\${process.env.CACHEIFY_DB_ID}/strings/session:9942\`, {
  method: 'PUT',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ value: 'active', expiresInMs: 300000 }),
});

// read back: 404 means the key expired or never existed
const { key } = await (await fetch(
  \`\${base}/api/data/\${process.env.CACHEIFY_DB_ID}/keys/session:9942\`,
  { headers: auth },
)).json();  // key.value, key.ttlMs`;

const PIPELINE = `curl -X POST ${API_EXAMPLE_ORIGIN}/api/data/$DB_ID/pipeline \\
  -H "Authorization: Bearer $RK_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"commands":[
        {"command":"HSET","args":["cart:7719","sku-1","2"]},
        {"command":"HSET","args":["cart:7719","sku-4","1"]},
        {"command":"HGETALL","args":["cart:7719"]}]}'`;

const SPRING_CONFIG = `# application.properties (values come from the environment, never hardcoded)
cacheify.base-url=\${CACHEIFY_BASE_URL:${API_EXAMPLE_ORIGIN}}
cacheify.database-id=\${CACHEIFY_DB_ID:}
cacheify.api-key=\${CACHEIFY_API_KEY:}`;

const SPRING_BRIDGE = `// Spring HTTP bridge: same OtpStore interface, Cacheify over REST instead
// of the Redis protocol. For serverless or locked-down-egress callers.
// storeOtpHash  -> PUT    /api/data/{dbId}/strings/{key}  (expiresInMs)
// getOtpHash    -> GET    /api/data/{dbId}/keys/{key}     (value + ttlMs)
// deleteOtpHash -> DELETE /api/data/{dbId}/keys/{key}
@Repository
public class HttpOtpStore implements OtpStore {

  private static final Duration TTL = Duration.ofMinutes(5);
  private static final String PREFIX = "myapp:otp:";

  private final RestTemplate http;
  private final String baseUrl, dbId, apiKey;

  public HttpOtpStore(RestTemplate cacheifyRestTemplate,
                      @Value("\${cacheify.base-url}") String baseUrl,
                      @Value("\${cacheify.database-id}") String dbId,
                      @Value("\${cacheify.api-key}") String apiKey) {
    this.http = cacheifyRestTemplate; this.baseUrl = baseUrl;
    this.dbId = dbId; this.apiKey = apiKey;
  }

  public void storeOtpHash(String email, String otpHash) {
    http.exchange(url("strings", email), HttpMethod.PUT,
        json(Map.of("value", otpHash, "expiresInMs", TTL.toMillis())), String.class);
  }

  public Optional<String> getOtpHash(String email) {
    try {
      Map<?, ?> env = http.getForObject(url("keys", email), Map.class);
      Map<?, ?> key = (Map<?, ?>) ((Map<?, ?>) env.get("data")).get("key");
      return Optional.ofNullable((String) key.get("value"));
    } catch (HttpStatusCodeException gone) {
      return Optional.empty();   // 404: never issued, consumed, or expired
    }
  }

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

export default function HttpDataPlanePage() {
  return (
    <>
      <header className="docs-head">
        <p className="dash-eyebrow">
          <span className="dot" aria-hidden="true" />
          Documentation
        </p>
        <h1>HTTP data plane</h1>
        <p>
          Advanced reference. The normal integration — for every Redis client —
          is the one-line{' '}
          <Link className="text-link" href="/docs/redis-gateway">Redis connection string</Link>.
          This page documents the JSON-over-HTTPS API that sits underneath it:
          the layer the gateway translates every Redis command into, and the
          endpoint list exposed through <code>openapi.json</code>. Reach for it
          only when you are building non-Redis tooling (HTTP probes, control
          scripts, restricted-egress callers).
        </p>
        <div className="docs-meta">
          <span><Icon name="shield-exclamation" /> Advanced reference</span>
          <span><Icon name="terminal" /> JSON envelope</span>
          <span><Icon name="key" /> Bearer rk_ keys</span>
        </div>
      </header>

      <section className="docs-section" id="connect">
        <h2><Icon name="plug" />Base path</h2>
        <p>Every data call lives under one base path:</p>
        <CodeBlock
          oneLine
          label="Service base path (not a client connection string)"
          text={`${API_EXAMPLE_ORIGIN}/api/data/{dbId}`}
        />
        <p>
          All requests take <code>Authorization: Bearer &lt;rk_…&gt;</code> — the
          database&apos;s single active API key. Redis array replies come back as
          JSON arrays; Redis nil is <code>null</code>; a missing or expired key is
          HTTP <code>404</code>.
        </p>
      </section>

      <section className="docs-section" id="endpoints">
        <h2><Icon name="list" />Endpoints</h2>
        <DocTable headers={['Method', 'Path', 'Purpose']} rows={ENDPOINTS} />
        <Callout title="The envelope never changes.">
          Success: <code>{'{"success":true,"data":…,"meta":…}'}</code>. Failure:{' '}
          <code>{'{"success":false,"error":{"code":"ERR_…","message":"…"}}'}</code>.
          Branch on <code>success</code>, read errors by code, not by string.
        </Callout>
        <p>Full machine-readable contract: <code>GET /api/openapi.json</code>.</p>
      </section>

      <section className="docs-section" id="cookbook">
        <h2><Icon name="code-slash" />Cookbook: store, then read</h2>
        <p>The two calls most auth flows need — a 5-minute TTL value and its read-back:</p>
        <CodeBlock label="cURL" text={CURL} />
        <CodeBlock label="Python (requests)" text={PYTHON} />
        <CodeBlock label="Node.js (native fetch)" text={NODE} />
      </section>

      <section className="docs-section" id="pipeline">
        <h2><Icon name="stack" />Pipeline instead of round-trips</h2>
        <p>
          Send a batch of 1-50 commands that execute in order with one HTTP
          round-trip; each reply comes back in its own element:
        </p>
        <CodeBlock label="3 chained commands, one request" text={PIPELINE} />
        <p>
          Per-database concurrency is capped server-side (<code>MAX_INFLIGHT_PER_DB</code>):
          a saturated database answers <code>429</code> + <code>Retry-After</code>{' '}
          immediately instead of holding your socket.
        </p>
      </section>

      <section className="docs-section" id="spring">
        <h2><Icon name="cup-hot" />Spring Boot without Redis deps</h2>
        <p>
          Spring&apos;s RedisTemplate speaks RESP over TCP — for that path use the{' '}
          <Link className="text-link" href="/docs/redis-gateway">gateway connection string</Link>.
          For serverless or restricted-egress deployments, the HTTP bridge below
          keeps the same interface so your service layer never learns the
          difference:
        </p>
        <CodeBlock label="application.properties" text={SPRING_CONFIG} />
        <CodeBlock label="HttpOtpStore.java (bridge)" text={SPRING_BRIDGE} />
        <ul>
          <li><code>404</code> maps to <code>Optional.empty()</code> — identical to a Redis nil read.</li>
          <li>URL-encode key names (<code>URLEncoder</code> covers <code>:</code> and <code>@</code> in e-mails).</li>
          <li>Wire the key through properties sourced from env vars; never hardcode it.</li>
        </ul>
      </section>

      <DocsPager slug="http-data-plane" />
    </>
  );
}
