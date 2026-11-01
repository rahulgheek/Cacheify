'use strict';

/** Data-plane module schemas (Redis command API + REST convenience endpoints). */

const { z } = require('zod');

const arg = z.union([z.string().max(100_000), z.number()]);

const commandClean = z.strictObject({
  command: z.string().trim().regex(/^[A-Za-z]{2,16}$/, 'Command must be a word like GET or SET')
    .transform((value) => value.toUpperCase()),
  args: z.array(arg).max(256).optional().default([]),
});

// pipeline reuses the cleaned command descriptor
const pipelineSchema = z.strictObject({
  commands: z
    .array(commandClean)
    .min(1)
    .max(50),
});

const stringPutSchema = z.strictObject({
  value: z.string().max(1_000_000, 'Value too large'),
  expiresInMs: z.number().int().positive().max(2_147_483_647_000).optional(),
});

const expireSchema = z.strictObject({
  expiresInMs: z.number().int().positive().max(2_147_483_647_000),
});

/* Compound deterministic rate limiting. Rules are [key, limit, windowMs]:
   fixed-window counters stored as ordinary (TTL-armed) keys in the database. */
const rateLimitSchema = z.strictObject({
  rules: z
    .array(
      z.tuple([
        z.string().min(1).max(512),
        z.number().int().min(1).max(1_000_000),
        z.number().int().min(1000).max(86_400_000),
      ]),
    )
    .min(1)
    .max(20),
});

const listKeysQuery = z.strictObject({
  pattern: z.string().max(256).optional(),
  cursor: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

module.exports = { commandSchema: commandClean, pipelineSchema, stringPutSchema, expireSchema, listKeysQuery, rateLimitSchema };
