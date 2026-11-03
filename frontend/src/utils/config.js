/**
 * Frontend runtime configuration.
 * The API lives on a SEPARATE origin (the Express backend in ../backend).
 * NEXT_PUBLIC_API_URL points at it — e.g. http://127.0.0.1:3000 in local dev
 * (frontend/.env.local) or the deployed API on https://cacheify.bot-keep.xyz.
 * An empty value means same-origin deployment (frontend and API share a host);
 * runtime calls in services/api.js then use relative paths.
 */

export const API_BASE = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/+$/, '');

/** Origin shown to users in example snippets (landing env sample, AI prompt,
 *  CLI copy box, manual blocks, the database page's connection string).
 *  Always an absolute origin of the API: when NEXT_PUBLIC_API_URL is not
 *  configured it falls back to the deployed API host, so public docs never
 *  display a localhost address. Distinct from API_BASE so runtime calls keep
 *  their same-origin semantics unchanged. */
export const API_EXAMPLE_ORIGIN = API_BASE || 'https://cacheify.bot-keep.xyz';

/** Absolute origin of the backend API (for connection strings shown to users). */
export function apiOrigin() {
  return API_EXAMPLE_ORIGIN;
}

/**
 * Public endpoint (host:port) of the RESP redis-protocol gateway — the door
 * native Redis clients (redis-cli, ioredis, redis-py, Jedis, Lettuce) dial.
 * It is a separate listener from the HTTPS API, so it gets its own address:
 * set NEXT_PUBLIC_GATEWAY_URL=<gateway-host:port> once the gateway is
 * deployed. Until then the displayed connection string keeps an obvious
 * placeholder so public docs never point at a dead endpoint.
 */
const GATEWAY_URL_RAW = process.env.NEXT_PUBLIC_GATEWAY_URL || '';

export const GATEWAY_ENDPOINT = GATEWAY_URL_RAW
  .replace(/^rediss?:\/\//, '') // scheme is fixed, keep only host:port
  .split('/')[0];               // tolerate a path/db suffix like /0

export const GATEWAY_CONFIGURED = GATEWAY_ENDPOINT.length > 0;

const GATEWAY_PLACEHOLDER = '<gateway-host>:<gateway-port>';

/** redis:// connection string for native Redis clients. The AUTH password
 *  slot is the database's active API key — the same rk_ credential the HTTP
 *  plane uses as the bearer token — and the database is always db 0. */
export function redisConnectionString(keyHint = 'rk_xxxxxxxx') {
  return `redis://:${keyHint}@${GATEWAY_CONFIGURED ? GATEWAY_ENDPOINT : GATEWAY_PLACEHOLDER}/0`;
}
