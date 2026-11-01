# Cacheify Redis Gateway (RESP)

A Redis-wire-protocol (RESP2 **and** RESP3) gateway that speaks plain
`redis://` / `rediss://` on one side and calls the existing Cacheify HTTPS data
plane on the other. **Zero changes** to the REST contract: the gateway is a
pure data-plane consumer (Bearer `rk_` keys only).

```
redis client ⟷ [net/TLS] ⟷ [RESP codec] ⟷ [cmd translator]
             ⟷ [shared keep-alive HTTP pool] ⟷ Cacheify REST /api/data/…
```

Runs on Node ≥ 18 (global `fetch`), **stdlib only**, one file, no deps.

## Quickstart (container = the "just works" path)

```bash
docker build -t cacheify-redis-gateway .

docker run -d --name cacheify-gw -p 6379:6379 \
  -e CACHEIFY_API_KEY=rk_xxxxxxxx \
  -e CACHEIFY_DB_ID=rdb_xxxxxxxx \
  -e GATEWAY_BYPASS_AUTH=1 \
  -e GATEWAY_HOST=0.0.0.0 \
  cacheify-redis-gateway
```

Then point ANY standard Redis client at home:

```bash
redis-cli -u redis://localhost:6379 SET greeting "hello cacheify"
redis-cli -u redis://localhost:6379 GET greeting
```

| Client | URL |
| --- | --- |
| redis-cli | `redis://localhost:6379` |
| redis-py | `redis.from_url("redis://localhost:6379")` |
| node-redis | `redis://localhost:6379` |
| go-redis | `redis.ParseURL("redis://localhost:6379")` |
| Jedis / Lettuce / Redisson | `redis://localhost:6379` via `RedisURI` |
| spring-data-redis | spring.redis.url `redis://localhost:6379` |

## Running outside Docker (same binary)

```bash
CACHEIFY_BASE_URL=https://cacheify.bot-keep.xyz \
CACHEIFY_API_KEY=rk_xxx CACHEIFY_DB_ID=rdb_xxx \
GATEWAY_BYPASS_AUTH=1 npm run gateway
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `CACHEIFY_API_KEY` | — | Bearer `rk_...` key used for all REST calls |
| `CACHEIFY_BASE_URL` | `https://cacheify.bot-keep.xyz` | REST base |
| `CACHEIFY_DB_ID` | — | target database (SELECT index 0) |
| `CACHEIFY_DB_MAP` | — | `0=rdb_aaa,1=rdb_bbb` index→database registry |
| `GATEWAY_BYPASS_AUTH` | off | `1`: AUTH not required (loopback container mode) |
| `GATEWAY_PORT` / `GATEWAY_HOST` | `6379` / `127.0.0.1` | listen endpoint |
| `GATEWAY_TLS_CERT` / `GATEWAY_TLS_KEY` | — | PEM files ⇒ `rediss://` (edge mode) |
| `REST_TIMEOUT_MS` | `5000` | per-call upstream deadline |
| `MAX_REST_INFLIGHT` | `32` | REST concurrency cap (backpressure) |
| `MAX_QUEUE` | `256` | per-connection pipelined-command cap |
| `MAX_CONNECTIONS` | `2000` | overall socket cap (refuse-not-freeze) |
| `GATEWAY_IDLE_TIMEOUT_MS` | `300000` | idle socket close |
| `GATEWAY_DEBUG` | off | `1`: log every upstream call (`method path -> status`) |

## Command mapping

| RESP command | Translation | Notes |
| --- | --- | --- |
| `AUTH password` | `rk_` API key, verified lazily on the first data command | 401 ⇒ `-NOAUTH` + close |
| `HELLO [2\|3]` | negotiates RESP3; reply is a server map | bad version ⇒ `-NOPROTO` |
| `SELECT n` | registry lookup | index 0 always `+OK` (virtual); unregistered ⇒ `-ERR DB index is out of range` |
| `PING`, `ECHO`, `QUIT`, `INFO` | answered **locally** (no REST) | `PING` works pre-AUTH — that is what container healthchecks expect |
| `CLIENT …`, `CONFIG …`, `COMMAND …` | local stubs | client libraries require these at boot |
| `SET k v [EX s\|PX ms]` | `PUT /strings/{k}` (`expiresInMs`) | **mandatory expiry**: no TTL ⇒ platform default (~24h), never immortal |
| `SET k v NX|XX|EXAT|PXAT|KEEPTTL|GET …` | `POST /command` verbatim | engine-side semantics |
| `SETEX k s v` / `PSETEX k ms v` | `PUT /strings/{k}` | |
| `EXPIRE k s` / `PEXPIRE k ms` | `POST /keys/{k}/expire` | `{applied:bool}` → `:1/:0`; missing key answers `:0` exactly like Redis |
| `GET/DEL/EXISTS/INCR/DECR/INCRBY/DECRBY/TTL/PTTL/TYPE/KEYS/SCAN/…` | `POST /command` pass-through | native semantics: `WRONGTYPE`, nil, atomic counters, globs |
| anything else | `POST /command` pass-through | unknown ⇒ `-ERR unknown command 'X'` |

**Pipelining**: ≥3 consecutive `/command`-style reads collapse into ONE
`POST /pipeline` round-trip. Replies always come back in order (per-connection
FIFO). A failed batch re-runs sequentially, so semantics never depend on
batching.

## Platform semantics (documented, by design)

- **No immortal keys.** `SET` without a TTL arms the platform default TTL
  (~24 h); `TTL`/`PTTL` therefore never answer `-1`; `PERSIST` is a 422, and
  pass-through PERSIST errors surface as `-ERR PERSIST is disabled…`.
- **One database per key.** Multi-db = one `rk_` key + URL per database
  (`CACHEIFY_DB_MAP`); a scoped key cannot escape its database (server 403).
- **PING is unauthenticated** and answered locally — used by the container
  healthcheck; it never reveals data.
- **Not supported (v1):** `MULTI/EXEC/WATCH`, pub/sub (`SUBSCRIBE*/), blocking
  commands (`BLPOP`…), Lua/`EVAL`, `MIGRATE`, cluster redirections. Unknown or
  unsupported verbs return normal Redis error replies (client retry logic, if
  any, decides).

## Reliability behavior

- Upstream 429 + `Retry-After` ⇒ global cooldown; during cooldown every data
  command immediately answers `-ERR RATE_LIMITED …` without touching REST.
- Upstream timeout/8xx ⇒ `-ERR CACHEIFY_UPSTREAM…` — **no silent retries**;
  client libraries own their retry policy.
- Per-connection queue cap (`MAX_QUEUE`, default 256): exceeded ⇒
  `-ERR RATE_LIMITED command pipeline too deep` + close (flood guard).
- REST concurrency capped globally (`MAX_REST_INFLIGHT`), and the REST side has
  its own per-db inflight guard (`429`) — the two compose cleanly.

## Deployment notes

- **Local/P1 (this container):** no ingress exposure at all; bind loopback.
  Security boundary = your machine. Recommended mode: `GATEWAY_BYPASS_AUTH=1`.
- **Edge/P2 (`rediss://`):** run with `GATEWAY_HOST=0.0.0.0` +
  `GATEWAY_TLS_CERT/KEY` (e.g. Let's Encrypt), a limited-rank firewall that
  allows only 6380, and NO bypass. Clients then use
  `redis://:rk_xxx@redis.your-domain.tld:6380/0` — the `rk_` key IS the
  password (lazy-verified against the REST plane).
- Wire test: `npm run test:gateway` (boots the embedded REST app, mints a real
  `rk_` key, spawns the gateway, and asserts 26 wire-level behaviors).
