FROM node:22-alpine

# cacheify-redis-gateway: RESP wire gateway in front of the Cacheify HTTPS
# data plane. Runs as a non-root user; uses ONLY Node stdlib (no npm install).
# Build context = THIS gateway/ folder (top level of the repo):
#   docker build -t cacheify-redis-gateway gateway/        (from repo root)
#   docker build -t cacheify-redis-gateway .               (from gateway/)

WORKDIR /app
COPY redis-gateway.js /app/redis-gateway.js
COPY healthcheck.js /app/healthcheck.js

ENV NODE_ENV=production \
    GATEWAY_HOST=127.0.0.1 \
    GATEWAY_PORT=6379

RUN addgroup -S gw && adduser -S gw -G gw && chown -R gw:gw /app
USER gw

EXPOSE 6379

HEALTHCHECK --interval=15s --timeout=4s --start-period=5s --retries=3 \
  CMD ["node", "/app/healthcheck.js"]

# Contract (see README.md): 
#   docker run -p 6379:6379 \
#     -e CACHEIFY_API_KEY=rk_xxx -e CACHEIFY_DB_ID=rdb_xxx \
#     -e GATEWAY_BYPASS_AUTH=1 -e GATEWAY_HOST=0.0.0.0 \
#     cacheify-redis-gateway
#   → your app speaks  redis://localhost:6379  (plain RESP2)
CMD ["node", "/app/redis-gateway.js"]
