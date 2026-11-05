# Cacheify frontend (Next.js App Router)

The complete UI for the Redis Hosting Platform: marketing landing page and the
signed-in console (databases, per-database command console + settings, API keys,
profile, admin control plane). JavaScript only — no TypeScript.

- **Next 16** App Router with the `src/` folder (`src/app`, `src/views`,
  `src/components/{common,layout,features}`, `src/hooks`/`services`/`store`/`router`/`utils`/`styles`).
- Talks to the **separate Express backend** (`backend/`, port **3000**) via
  `src/services/*` using the `{ success, data, meta }` / error-envelope contract.
- Landing page keeps its original Tailwind look via the Play CDN loaded directly
  in `src/app/page.js`; console pages use `src/styles/tokens.css` + `main.css`
  (ported rule-for-rule from the original design, icons via `react-bootstrap-icons`).
- Routing is shared-origin: `(site)` route group renders views through `AuthGate`
  (public / user / admin / unverified-verify guard semantics). Page logic lives in
  `src/views/*Page.jsx`, not in `src/app` route files.

## Quick start

```powershell
npm install
npm run dev      # next dev -p 3001  →  http://localhost:3001
npm run build    # production build (static + dynamic [id] routes)
```

## Configuration

Deployed frontend: **https://cacheify-redis-host.vercel.app** (the API it talks
to lives on the separate origin set below — never at the frontend URL itself).

On Vercel, set:

```text
NEXT_PUBLIC_API_URL=https://cacheify.bot-keep.xyz
NEXT_PUBLIC_GATEWAY_URL=<gateway-host>:<gateway-port>   # once the RESP gateway is live
```

`NEXT_PUBLIC_*` values are inlined at build time (redeploy after changes). For
local development, create `.env.local` (never committed):

```powershell
NEXT_PUBLIC_API_URL=http://<local-api-host>:<port>   # loopback backend on another origin
```

An empty value means a same-origin deployment (frontend and API share a host).
See `src/utils/config.js` (`API_BASE`, `apiOrigin()`).

## Development notes

- Dev servers on loopback alternate hosts must allow dev origins: the config
  already sets `allowedDevOrigins: ['127.0.0.1']` (Next 16 blocks cross-origin
  dev assets like `/_next/hmr` by default).
- `npm test` / smoke checks live in `backend/` (the API owns end-to-end tests).
