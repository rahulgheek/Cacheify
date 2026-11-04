'use strict';

/**
 * pm2 process config for the Cacheify RESP gateway.
 *
 *   pm2 start ecosystem.config.js
 *   pm2 save        (optional: resurrect after reboots)
 *   pm2 logs cacheify-gateway
 *
 * Reads the same environment as the direct `npm start` path: either export
 * the variables or use the `env_file` block below (edit it to match your
 * gateway/.env values; pm2 does not parse .env files on its own).
 */

module.exports = {
  apps: [
    {
      name: 'cacheify-gateway',
      script: 'redis-gateway.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      min_uptime: '5s',
      restart_delay: 1000,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        // Keep in sync with gateway/.env - pm2 does not read .env itself.
        // CACHEIFY_BASE_URL: 'https://cacheify.bot-keep.xyz',
        // GATEWAY_HOST: '0.0.0.0',
        // GATEWAY_PORT: '44141',
      },
      out_file: './logs/cacheify-gateway-out.log',
      error_file: './logs/cacheify-gateway-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
