import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { loadConfig } from "./config.ts";
import { ClaudeError, checkBinary, runClaude, runClaudeMultimodal, streamClaude } from "./claude.ts";
import { openAIToAnthropicMessages, openAIToClaudePrompt } from "./openai.ts";
import {
  ErrorResponseSchema,
  HealthResponseSchema,
  ModelInfoSchema,
  OpenAIChatRequestSchema,
  RunRequestSchema,
  type ModelInfo,
  type OpenAIChatChunk,
  type OpenAIChatResponse,
  type OpenAIUsage,
} from "./types.ts";

const PACKAGE_VERSION = "0.1.0";
const KNOWN_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", tier: "opus" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", tier: "opus" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", tier: "opus" },
  { id: "claude-opus-4-5", label: "Claude Opus 4.5", tier: "opus" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "sonnet" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", tier: "sonnet" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", tier: "haiku" },
  // Псевдонимы Claude Code CLI (разрешают всегда идти к latest-версии семейства)
  { id: "opus", label: "Claude Opus (latest)", tier: "opus" },
  { id: "sonnet", label: "Claude Sonnet (latest)", tier: "sonnet" },
  { id: "haiku", label: "Claude Haiku (latest)", tier: "haiku" },
];

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

function err(code: string, message: string, details?: unknown) {
  return ErrorResponseSchema.parse({ error: { code, message, details } });
}

const config = loadConfig();
if (config.defaultCwd) process.chdir(config.defaultCwd);

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: config.corsOrigins.split(",").map((o) => o.trim()),
    credentials: false,
  }),
);

app.use("*", async (c, next) => {
  if (!config.apiToken) return next();
  if (c.req.path === "/health") return next();
  const header = c.req.header("authorization") ?? "";
  const expected = `Bearer ${config.apiToken}`;
  if (header !== expected) {
    return c.json(err("UNAUTHORIZED", "Invalid or missing API token"), 401);
  }
  return next();
});

function openAiErrorBody(code: string, message: string, type: string) {
  return {
    error: {
      message,
      type,
      param: null,
      code,
    },
  };
}

app.get("/", (c) =>
  c.json({
    name: "claude-server",
    version: PACKAGE_VERSION,
    endpoints: [
      "GET  /",
      "GET  /health",
      "GET  /v1/models",
      "POST /v1/run",
      "POST /v1/run/stream",
      "POST /v1/chat/completions  (OpenAI-compatible)",
    ],
  }),
);

app.get("/health", async (c) => {
  const bin = await checkBinary(CLAUDE_BIN);
  if (!bin.ok) {
    return c.json(
      err("CLAUDE_NOT_FOUND", `Бинарь ${CLAUDE_BIN} не найден в PATH`),
      503,
    );
  }
  return c.json(
    HealthResponseSchema.parse({
      status: "ok" as const,
      version: PACKAGE_VERSION,
      claude: { binary: CLAUDE_BIN, version: bin.version },
    }),
  );
});

app.get("/v1/models", (c) => {
  const data = KNOWN_MODELS.map((m) => ({
    id: m.id,
    object: "model",
    created: 0,
    owned_by: "anthropic",
  }));
  return c.json({ object: "list", data });
});

app.post("/v1/run", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("INVALID_JSON", "Request body must be valid JSON"), 400);
  }

  const parsed = RunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      err("VALIDATION_ERROR", "Invalid request body", parsed.error.flatten()),
      400,
    );
  }

  try {
    const response = await runClaude(parsed.data, {
      binary: CLAUDE_BIN,
      timeoutMs: config.claudeTimeoutMs,
      defaultModel: config.defaultModel,
    });
    return c.json(response);
  } catch (e) {
    if (e instanceof ClaudeError) {
      const status =
        e.code === "BINARY_NOT_FOUND" ? 503 : e.code === "TIMEOUT" ? 504 : 500;
      return c.json(err(e.code, e.message, e.details), status);
    }
    return c.json(err("INTERNAL_ERROR", (e as Error).message), 500);
  }
});

app.post("/v1/run/stream", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("INVALID_JSON", "Request body must be valid JSON"), 400);
  }

  const parsed = RunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      err("VALIDATION_ERROR", "Invalid request body", parsed.error.flatten()),
      400,
    );
  }

  return streamSSE(c, async (stream) => {
    let id = 0;
    const send = async (event: string, data: unknown) => {
      id += 1;
      await stream.writeSSE({
        id: String(id),
        event,
        data: JSON.stringify(data),
      });
    };

    try {
      await send("start", { model: parsed.data.model ?? config.defaultModel });

      const result = await streamClaude(
        parsed.data,
        {
          binary: CLAUDE_BIN,
          timeoutMs: config.claudeTimeoutMs,
          defaultModel: config.defaultModel,
        },
        async (event) => {
          await send("event", event);
        },
        c.req.raw.signal,
      );

      await send("done", result);
    } catch (e) {
      if (e instanceof ClaudeError) {
        await send("error", {
          code: e.code,
          message: e.message,
          details: e.details,
        });
      } else {
        await send("error", {
          code: "INTERNAL_ERROR",
          message: (e as Error).message,
        });
      }
    }
  });
});

// --- OpenAI Chat Completions (compatible) ---------------------------------

function buildOpenAIUsage(
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  completionChars: number,
): OpenAIUsage {
  const prompt = usage?.inputTokens ?? 0;
  const completion = usage?.outputTokens ?? Math.ceil(completionChars / 4);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

app.post("/v1/chat/completions", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      openAiErrorBody(
        "invalid_request_error",
        "Request body must be valid JSON",
        "invalid_request_error",
      ),
      400,
    );
  }

  const parsed = OpenAIChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      openAiErrorBody(
        "invalid_request_error",
        "Invalid request body",
        "invalid_request_error",
      ),
      400,
    );
  }

  const req = parsed.data;
  let converted: ReturnType<typeof openAIToClaudePrompt>;
  try {
    converted = openAIToClaudePrompt(req.messages);
  } catch (e) {
    return c.json(
      openAiErrorBody(
        "invalid_request_error",
        (e as Error).message,
        "invalid_request_error",
      ),
      400,
    );
  }

  const model = req.model ?? config.defaultModel;
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (!req.stream) {
    try {
      const mm = converted.hadMultimodal ? openAIToAnthropicMessages(req.messages) : null;
      const response = mm
        ? await runClaudeMultimodal(
            mm.messages,
            mm.systemPrompt,
            model,
            { binary: CLAUDE_BIN, timeoutMs: config.claudeTimeoutMs, defaultModel: config.defaultModel },
          )
        : await runClaude(
            { model, prompt: converted.userPrompt, systemPrompt: converted.systemPrompt },
            { binary: CLAUDE_BIN, timeoutMs: config.claudeTimeoutMs, defaultModel: config.defaultModel },
          );
      const bodyOut: OpenAIChatResponse = {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: response.result },
            finish_reason: "stop",
          },
        ],
        usage: buildOpenAIUsage(response.usage, response.result.length),
      };
      return c.json(bodyOut);
    } catch (e) {
      if (e instanceof ClaudeError) {
        const status =
          e.code === "BINARY_NOT_FOUND"
            ? 503
            : e.code === "TIMEOUT"
              ? 504
              : e.code === "MODEL_NOT_FOUND" || e.code === "UNAUTHORIZED"
                ? 400
                : 500;
        return c.json(
          openAiErrorBody(
            e.code,
            e.message,
            e.code === "MODEL_NOT_FOUND"
              ? "invalid_request_error"
              : "server_error",
          ),
          status,
        );
      }
      return c.json(
        openAiErrorBody("internal_error", (e as Error).message, "server_error"),
        500,
      );
    }
  }

  // Streaming — emulate OpenAI Chat Completions stream format
  c.header("Content-Type", "text/event-stream; charset=utf-8");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    const write = async (chunk: OpenAIChatChunk) => {
      await stream.writeSSE({
        event: "message",
        data: JSON.stringify(chunk),
      });
    };

    const headerChunk: OpenAIChatChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ],
    };
    await write(headerChunk);

    let fullText = "";
    try {
      if (converted.hadMultimodal) {
        const mm = openAIToAnthropicMessages(req.messages);
        const response = await runClaudeMultimodal(
          mm.messages,
          mm.systemPrompt,
          model,
          { binary: CLAUDE_BIN, timeoutMs: config.claudeTimeoutMs, defaultModel: config.defaultModel },
        );
        if (response.result) {
          fullText = response.result;
          await write({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content: fullText }, finish_reason: null }],
          });
        }
      } else {
        const result = await streamClaude(
          {
            model,
            prompt: converted.userPrompt,
            systemPrompt: converted.systemPrompt,
          },
          {
            binary: CLAUDE_BIN,
            timeoutMs: config.claudeTimeoutMs,
            defaultModel: config.defaultModel,
          },
          async (event) => {
            if (event.type === "assistant") {
              const msg = event.message as
                | { content?: Array<{ type: string; text?: string }> }
                | undefined;
              const text = msg?.content
                ?.filter((p) => p.type === "text")
                .map((p) => p.text ?? "")
                .join("");
              if (text) {
                fullText += text;
                const chunk: OpenAIChatChunk = {
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    { index: 0, delta: { content: text }, finish_reason: null },
                  ],
                };
                await write(chunk);
              }
            }
          },
          c.req.raw.signal,
        );

        if (result.result && result.result.length > fullText.length) {
          const tail = result.result.slice(fullText.length);
          fullText += tail;
          const chunk: OpenAIChatChunk = {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              { index: 0, delta: { content: tail }, finish_reason: null },
            ],
          };
          await write(chunk);
        }
      }

      const finalChunk: OpenAIChatChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      await write(finalChunk);
      await stream.writeSSE({ event: "message", data: "[DONE]" });
    } catch (e) {
      const code = e instanceof ClaudeError ? e.code : "internal_error";
      const message = (e as Error).message;
      const errChunk = openAiErrorBody(code, message, "server_error");
      await stream.writeSSE({
        event: "message",
        data: JSON.stringify(errChunk),
      });
      await stream.writeSSE({ event: "message", data: "[DONE]" });
    }
  });
});

const port = config.port;
console.log(`[claude-server] starting on http://localhost:${port}`);
console.log(`[claude-server] binary: ${CLAUDE_BIN}`);
console.log(`[claude-server] default model: ${config.defaultModel}`);
console.log(
  `[claude-server] auth: ${config.apiToken ? "enabled" : "disabled"}`,
);

export default {
  port,
  fetch: app.fetch,
};
