# Cacheify — managed Redis-compatible memory for every project

Cacheify gives any application an isolated, Redis-compatible database through
one scoped credential. You get the Redis data model — strings, counters,
hashes, lists, sets, sorted sets — without operating a server, and the platform
stands between your commands and the data to enforce what raw Redis cannot:
tenant isolation, scoped keys, quotas, rate limits and mandatory expiry.

There is nothing to install on the client side. A database is reachable as
**one line** — a standard `redis://` connection string whose password is the
database's active API key:

```text
redis://:<your-key>@<gateway-host>:<port>/0
```

Any native Redis client dials it unchanged (redis-cli, ioredis, redis-py,
Jedis, Lettuce, Spring RedisTemplate, go-redis), and it leads to the same
keyspace with the same guarantees your web dashboard sees. Underneath, the
gateway translates Redis commands into an internal JSON-over-HTTPS API — that
layer is kept as an advanced reference (see the docs), never a second
connection string to choose between.

---

## Mental model

One shared infrastructure, many tenants, zero shared state. Cacheify is built
around four layers:

```
┌─────────────────────────────────────────────────────────────────┐
│  consumers                                                      │
│  desktop Redis clients (RESP)          browser + HTTP services  │
│        │                                       │                │
│        ▼                                       ▼                │
│  ┌──────────────┐                    ┌──────────────────┐       │
│  │ RESP gateway │  translates Redis  │  HTTPS data plane │       │
│  │ (redis://)   │  commands to REST  │  (JSON over TLS)  │       │
│  └──────┬───────┘                    └────────┬─────────┘       │
│         └──────────────┬──────────────────────┘                 │
│                        ▼                                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ control plane: auth, permissions, rate limits, quotas,  │    │
│  │ validation, audit trail                                 │    │
│  └───────────────────────────┬─────────────────────────────┘    │
│                              ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ tenant namespaces — every database is a sealed          │    │
│  │ keyspace (rh:<namespace>:<key>) on the backing store    │    │
│  └───────────────────────────┬─────────────────────────────┘    │
│                              ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ data plane engines: embedded engine (default) or a real │    │
│  │ Redis server the operator configured                     │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

What that means in practice, per layer:

1. **Every credential is a key, and every key is a fence.** A database has
   exactly one active API key (`rk_…`), scoped either read-only or read-write.
   The credential selects the database: under RESP it is the AUTH password that
   pins the whole connection to one virtual database (always db 0); over HTTP
   it is the Bearer token on every call. Nothing a client does can step past
   that fence — key names are rewritten into the tenant namespace
   (`rh:<namespace>:<key>`) at the boundary and rewritten back on replies.

2. **The platform answers only after the checks pass.** Identity, permission,
   account verification, body-size limits, per-database concurrency, public
   rate limits and plan quotas are evaluated before a command executes. A
   saturated database gets `429` + `Retry-After` instead of a queue; an
   over-quota write is rolled back atomically; nothing partially lands.

3. **Expiry is mandatory.** Every key carries a TTL — plain writes inherit the
   24-hour platform default, longer or shorter TTLs are armed explicitly,
   and `PERSIST` does not exist. Forgotten keys cannot become silent cost.

4. **The backing store is an implementation detail.** The same command surface
   runs on the embedded engine (zero config) or against an operator's real
   Redis server. Clients never know, and the operator's credentials never leak
   into any response, log line or docs page; auth sessions are HMAC-signed
   server-side tokens, and the Redis connection is TLS-pinned by the operator.

One mental shorthand for the whole system: **Cacheify turns the Redis request
path into an API with a bouncer, a meter and a janitor.** The bouncer checks
credentials and permissions, the meter enforces quotas and rate limits, and the
janitor guarantees every key leaves eventually.

---

## Integration

### Onboarding, four steps

1. Create an account (e-mail + password, code verified).
2. Create a database (five are free — each is fully isolated).
3. Mint its scoped key (read-only or read-write; plaintext shown once).
4. Put the one-line connection string into your project's `REDIS_URL`.

### Connection — one line

```text
redis://:<your-key>@<gateway-host>:<port>/0
```

Your key is the password slot. Redis semantics hold: standard clients connect
unchanged, RESP2 and RESP3 (HELLO handshake) are both supported, pipelines
behave like sequential execution, `KEYS`/`SCAN` patterns stay inside the
namespace, and unknown verbs answer exactly like Redis
(`-ERR unknown command`, nothing executed).

Documented boundaries (deliberate platform limits): transactions
(`MULTI`/`EXEC`/`WATCH`), blocking verbs (`BLPOP`/`BRPOP`…), pub/sub and
scripting (`EVAL`) are not part of the multi-tenant surface.

### For tooling and code assistants

- `GET /llms.txt` — short machine-readable product index
- `GET /api/openapi.json` — full OpenAPI 3.1 contract of the HTTPS plane

### Errors survive, predictably

Every failure is structured, branch by `code` (`ERR_UNAUTHORIZED`,
`ERR_FORBIDDEN`, `ERR_QUOTA_EXCEEDED`, `ERR_NOT_FOUND`, `ERR_RATE_LIMITED`…),
with `429`/`503` the only retryable classes. Missing/expired keys are `404`
over HTTP and `nil` over RESP — the same meaning as Redis nil.

---

## Product guarantees

| Guarantee | How it holds |
| --- | --- |
| Tenant isolation | Sealed namespaces; cross-tenant reads are structurally impossible (404 contract, not an error leak) |
| Credential scope | One active key per database, read-only or read-write, enforced server-side before execution |
| Quotas | Database / key / value-size ceilings with atomic rollback beyond them |
| Fairness | Rate limiting + per-database in-flight caps with immediate 429 + Retry-After |
| Mandatory expiry | Default 24 h TTL on every write; PERSIST refused; countdown readable (`ttlMs` / `TTL`) |
| Replayability | Audit trail on key and database lifecycle events; request ids on every call |

## Technology

| Layer | Technology | Why it is there |
| --- | --- | --- |
| Frontend | Next.js 16 (App Router), React 19, plain JavaScript, Vercel | Product site (landing, blog, privacy) + full developer console in one deploy; static docs pages, guarded app routes |
| API / control plane | Node.js 24 + Express 5 + MongoDB (official driver) | JSON API with stateless bearer sessions; users, databases, hashed API keys and audit events live in MongoDB |
| Validation & policy | Zod schemas, engine command registry, bcryptjs | Strict request shapes; permission + quota checks run before every command; OTP login over Brevo/SMTP |
| Data plane (two engines) | Embedded Redis-compatible engine on MongoDB collections, or `ioredis` 6 against a real Redis server (`rediss://` + CA pinning) | One contract either way; namespaces (`rh:<ns>:<key>`) enforced at the driver boundary |
| RESP gateway | Node stdlib only (`net`/`tls`) — zero npm dependencies | Speaks RESP2/RESP3 (HELLO, inline commands, pipelining with batch collapse), translates every Redis command into an authenticated REST call, per-connection queue caps and idle timeouts |
| Security | HMAC-signed bearer session tokens (Node stdlib crypto), bcryptjs password hashing, hashed API keys, CORS exact-match allowlist, strict error envelopes | Least-surface defaults; no secrets in the browser/console |
| Operations | pm2 + ecosystem config, Docker (non-root gateway image), health probes | Panel-friendly deployment; liveness without touching the data plane |
| Tests | End-to-end smoke suite, 7-framework client kit, RESP wire suites (embedded + live) | Every documented behavior on the pages above is executed by a test, per transport |

## Repository map

```
backend/    Cacheify API  (Express 5, MongoDB, data planes)   → app README
frontend/   Cacheify UI   (Next.js 16: landing + console)    → app README
gateway/    RESP gateway (stdlib-only, self-contained)       → app README
```

## Run it locally (helpful, optional)

Live deployment: **UI** <https://cacheify-redis-host.vercel.app> · **API**
<https://cacheify.bot-keep.xyz> — integration readers need nothing from this
section; it exists only to run all three processes on a laptop.

```powershell
# terminal 1 — API (needs backend/.env; start from backend/.env.example)
cd backend  ; npm install ; npm start          # loopback API, port from .env

# terminal 2 — UI
cd frontend ; npm install ; npm run dev        # UI on loopback (script pins -p 3001)

# terminal 3 — RESP gateway (needs gateway/.env; start from gateway/.env.example)
cd gateway  ; npm start                        # local Redis endpoint redis://...:6379
```

Client-facing documentation lives in the product itself: `/docs` (hub) with
per-topic guides for quick start, RESP gateway, HTTP data plane, architecture,
TTL policy, errors and FAQ.
