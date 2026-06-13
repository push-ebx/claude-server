import { z } from "zod";

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(4317),
  claudeTimeoutMs: z.coerce.number().int().positive().default(300_000),
  defaultModel: z.string().default("claude-sonnet-4-6"),
  defaultCwd: z.string().optional(),
  apiToken: z.string().optional(),
  corsOrigins: z.string().default("*"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  return ConfigSchema.parse({
    port: process.env.PORT,
    claudeTimeoutMs: process.env.CLAUDE_TIMEOUT_MS,
    defaultModel: process.env.CLAUDE_DEFAULT_MODEL,
    defaultCwd: process.env.CLAUDE_CWD || undefined,
    apiToken: process.env.API_TOKEN || undefined,
    corsOrigins: process.env.CORS_ORIGINS,
  });
}
