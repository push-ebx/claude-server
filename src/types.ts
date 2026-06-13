import { z } from "zod";

export const RunRequestSchema = z.object({
  model: z.string().min(1).optional(),
  prompt: z.string().min(1).max(1_000_000),
  systemPrompt: z.string().max(100_000).optional(),
  appendSystemPrompt: z.string().max(100_000).optional(),
  allowedTools: z.string().max(1_000).optional(),
  disallowedTools: z.string().max(1_000).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(1_800_000).optional(),
  resumeSession: z.string().optional(),
});

export type RunRequest = z.infer<typeof RunRequestSchema>;

export const ModelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  tier: z.enum(["opus", "sonnet", "haiku"]),
});

export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const RunResponseSchema = z.object({
  result: z.string(),
  sessionId: z.string().optional(),
  model: z.string(),
  durationMs: z.number(),
  costUsd: z.number().optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      cacheReadTokens: z.number().optional(),
      cacheWriteTokens: z.number().optional(),
    })
    .optional(),
  isError: z.boolean().default(false),
  raw: z.string().optional(),
});

export type RunResponse = z.infer<typeof RunResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  claude: z.object({
    binary: z.string(),
    version: z.string().optional(),
  }),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// --- OpenAI Chat Completions compatibility -------------------------------

const OpenAIContentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({
      url: z.string(),
      detail: z.enum(["low", "high", "auto"]).optional(),
    }),
  }),
]);

export const OpenAIMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool", "function"]),
  content: z.union([z.string(), z.array(OpenAIContentPartSchema)]).optional(),
  name: z.string().optional(),
});

export const OpenAIChatRequestSchema = z.object({
  model: z.string().min(1).optional(),
  messages: z.array(OpenAIMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.number().int().positive().default(1),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional().default(false),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  user: z.string().optional(),
  // Leadforge / Vercel AI SDK commonly pass extra metadata; we accept-and-ignore.
  metadata: z.record(z.string(), z.unknown()).optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  response_format: z.unknown().optional(),
});

export type OpenAIChatRequest = z.infer<typeof OpenAIChatRequestSchema>;
export type OpenAIMessage = z.infer<typeof OpenAIMessageSchema>;

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop" | "length" | "content_filter" | "tool_calls";
  }>;
  usage: OpenAIUsage;
}

export interface OpenAIChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: "stop" | "length" | null;
  }>;
}
