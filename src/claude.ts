import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { RunRequest, RunResponse } from "./types.ts";

export interface ClaudeRunOptions {
  binary: string;
  timeoutMs: number;
  defaultModel: string;
}

export interface ClaudeStreamEvent {
  type:
    | "system"
    | "assistant"
    | "user"
    | "result"
    | "stream_event"
    | "tool_use"
    | "tool_result";
  [key: string]: unknown;
}

export class ClaudeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "BINARY_NOT_FOUND"
      | "TIMEOUT"
      | "NON_ZERO_EXIT"
      | "INVALID_JSON"
      | "SPAWN_FAILED"
      | "MODEL_NOT_FOUND"
      | "MODEL_ERROR"
      | "UNAUTHORIZED",
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ClaudeError";
  }
}

async function checkBinary(
  binary: string,
): Promise<{ ok: boolean; version?: string }> {
  return new Promise((resolveCheck) => {
    const proc = spawn(binary, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.on("error", () => resolveCheck({ ok: false }));
    proc.on("close", (code) => {
      if (code === 0) {
        const first = stdout.trim().split(/\s+/, 1)[0];
        resolveCheck({ ok: true, version: first });
      } else {
        resolveCheck({ ok: false });
      }
    });
  });
}

interface RawClaudeJson {
  type?: string;
  result?: string;
  is_error?: boolean;
  api_error_status?: number | null;
  session_id?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  message?: string;
}

function buildArgs(req: RunRequest, model: string): string[] {
  const args: string[] = ["-p", "--model", model, "--output-format", "json"];
  if (req.resumeSession) {
    args.push("--resume", req.resumeSession);
  }
  if (req.systemPrompt) {
    args.push("--system-prompt", req.systemPrompt);
  }
  if (req.appendSystemPrompt) {
    args.push("--append-system-prompt", req.appendSystemPrompt);
  }
  if (req.allowedTools) {
    args.push("--allowedTools", req.allowedTools);
  }
  if (req.disallowedTools) {
    args.push("--disallowedTools", req.disallowedTools);
  }
  args.push(req.prompt);
  return args;
}

export async function runClaude(
  req: RunRequest,
  opts: ClaudeRunOptions,
): Promise<RunResponse> {
  const model = req.model ?? opts.defaultModel;
  const args = buildArgs(req, model);
  const cwd = req.cwd ? resolve(req.cwd) : process.cwd();

  return new Promise<RunResponse>((promiseResolve, reject) => {
    const start = Date.now();
    let proc;
    try {
      proc = spawn(opts.binary, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      reject(
        new ClaudeError(
          `Не удалось запустить ${opts.binary}: ${(err as Error).message}`,
          "SPAWN_FAILED",
          err,
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5_000).unref();
    }, req.timeoutMs ?? opts.timeoutMs);
    timer.unref();

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new ClaudeError(
            `Бинарь ${opts.binary} не найден. Установите Claude Code CLI: https://claude.com/download`,
            "BINARY_NOT_FOUND",
          ),
        );
      } else {
        reject(
          new ClaudeError(
            `Ошибка запуска процесса: ${err.message}`,
            "SPAWN_FAILED",
            err,
          ),
        );
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;

      if (killed) {
        reject(
          new ClaudeError(
            `Claude превысил таймаут ${req.timeoutMs ?? opts.timeoutMs}мс`,
            "TIMEOUT",
            { stderr, durationMs },
          ),
        );
        return;
      }

      if (code !== 0) {
        // Claude CLI иногда возвращает exit != 0 с валидным JSON-ответом,
        // где is_error=true. Попытаемся распарсить и извлечь осмысленное
        // сообщение (например, "model not found").
        let prettyMessage = `Claude завершился с кодом ${code}`;
        let resolvedCode: ClaudeError["code"] = "NON_ZERO_EXIT";
        try {
          const parsedErr = JSON.parse(stdout) as RawClaudeJson;
          if (parsedErr.result || parsedErr.message) {
            prettyMessage =
              parsedErr.result ?? parsedErr.message ?? prettyMessage;
            const apiStatus = parsedErr.api_error_status ?? 0;
            resolvedCode =
              apiStatus === 404
                ? "MODEL_NOT_FOUND"
                : apiStatus === 401 || apiStatus === 403
                  ? "UNAUTHORIZED"
                  : "MODEL_ERROR";
          }
        } catch {
          // stdout не JSON — оставляем дефолтное сообщение
        }
        reject(
          new ClaudeError(prettyMessage, resolvedCode, {
            exitCode: code,
            stderr,
            stdout,
            durationMs,
          }),
        );
        return;
      }

      let parsed: RawClaudeJson;
      try {
        parsed = JSON.parse(stdout) as RawClaudeJson;
      } catch {
        reject(
          new ClaudeError("Claude вернул невалидный JSON", "INVALID_JSON", {
            stdout,
            stderr,
          }),
        );
        return;
      }

      // Claude CLI может вернуть exit 0 с is_error: true при ошибке модели
      // (например, модель недоступна). Преобразуем в MODEL_ERROR.
      if (parsed.is_error) {
        const apiStatus = parsed.api_error_status ?? 0;
        const resultText = parsed.result ?? parsed.message ?? "(no result)";
        const code =
          apiStatus === 404
            ? "MODEL_NOT_FOUND"
            : apiStatus === 401 || apiStatus === 403
              ? "UNAUTHORIZED"
              : "MODEL_ERROR";
        reject(
          new ClaudeError(resultText, code as ClaudeError["code"], {
            apiStatus,
            raw: parsed,
          }),
        );
        return;
      }

      const result = parsed.result ?? parsed.message ?? stdout.trim();
      const usage = parsed.usage;
      const response: RunResponse = {
        result,
        sessionId: parsed.session_id,
        model,
        durationMs,
        costUsd: parsed.total_cost_usd,
        usage: usage
          ? {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              cacheReadTokens: usage.cache_read_input_tokens,
              cacheWriteTokens: usage.cache_creation_input_tokens,
            }
          : undefined,
        isError: false,
      };
      promiseResolve(response);
    });
  });
}

export async function streamClaude(
  req: RunRequest,
  opts: ClaudeRunOptions,
  onEvent: (event: ClaudeStreamEvent) => void,
  signal?: AbortSignal,
): Promise<{ durationMs: number; result?: string }> {
  const model = req.model ?? opts.defaultModel;
  const args: string[] = [
    "-p",
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (req.resumeSession) args.push("--resume", req.resumeSession);
  if (req.systemPrompt) args.push("--system-prompt", req.systemPrompt);
  if (req.appendSystemPrompt)
    args.push("--append-system-prompt", req.appendSystemPrompt);
  if (req.allowedTools) args.push("--allowedTools", req.allowedTools);
  if (req.disallowedTools) args.push("--disallowedTools", req.disallowedTools);
  args.push(req.prompt);

  const cwd = req.cwd ? resolve(req.cwd) : process.cwd();

  return new Promise((promiseResolve, reject) => {
    const start = Date.now();
    let proc;
    try {
      proc = spawn(opts.binary, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      reject(
        new ClaudeError(
          `Spawn failed: ${(err as Error).message}`,
          "SPAWN_FAILED",
          err,
        ),
      );
      return;
    }

    let buffer = "";
    let finalResult: string | undefined;
    let aborted = false;

    const cleanup = () => {
      if (aborted) return;
      aborted = true;
      if (signal && !signal.aborted)
        signal.removeEventListener("abort", onAbort);
      try {
        proc.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 5_000).unref();
    };

    const onAbort = () => {
      aborted = true;
      cleanup();
      reject(new ClaudeError("Aborted by client", "TIMEOUT"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort);
    }

    const timer = setTimeout(() => {
      aborted = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5_000).unref();
      reject(
        new ClaudeError(
          `Claude превысил таймаут ${req.timeoutMs ?? opts.timeoutMs}мс`,
          "TIMEOUT",
        ),
      );
    }, req.timeoutMs ?? opts.timeoutMs);
    timer.unref();

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as ClaudeStreamEvent;
          onEvent(event);
          if (event.type === "result" && typeof event.result === "string") {
            finalResult = event.result;
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      onEvent({ type: "stream_event", kind: "stderr", data: text });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      cleanup();
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new ClaudeError(
            `Бинарь ${opts.binary} не найден`,
            "BINARY_NOT_FOUND",
          ),
        );
      } else {
        reject(new ClaudeError(err.message, "SPAWN_FAILED", err));
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (aborted) return;
      if (signal) signal.removeEventListener("abort", onAbort);
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim()) as ClaudeStreamEvent;
          onEvent(event);
          if (event.type === "result" && typeof event.result === "string") {
            finalResult = event.result;
          }
        } catch {}
      }
      if (code !== 0 && !finalResult) {
        reject(
          new ClaudeError(
            `Claude завершился с кодом ${code}`,
            "NON_ZERO_EXIT",
            { code },
          ),
        );
        return;
      }
      promiseResolve({ durationMs: Date.now() - start, result: finalResult });
    });
  });
}

export { checkBinary };

export type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "image"; source: { type: "url"; url: string } };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

export async function runClaudeMultimodal(
  messages: AnthropicMessage[],
  systemPrompt: string | undefined,
  model: string,
  opts: ClaudeRunOptions,
): Promise<RunResponse> {
  const args: string[] = [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--input-format",
    "stream-json",
  ];
  if (systemPrompt) args.push("--system-prompt", systemPrompt);

  return new Promise<RunResponse>((promiseResolve, reject) => {
    const start = Date.now();
    let proc;
    try {
      proc = spawn(opts.binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      reject(
        new ClaudeError(
          `Не удалось запустить ${opts.binary}: ${(err as Error).message}`,
          "SPAWN_FAILED",
          err,
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5_000).unref();
    }, opts.timeoutMs);
    timer.unref();

    try {
      for (const msg of messages) {
        const event = JSON.stringify({
          type: msg.role,
          message: { role: msg.role, content: msg.content },
        });
        proc.stdin!.write(event + "\n");
      }
      proc.stdin!.end();
    } catch {
      // stdin closed early
    }

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new ClaudeError(
            `Бинарь ${opts.binary} не найден. Установите Claude Code CLI: https://claude.com/download`,
            "BINARY_NOT_FOUND",
          ),
        );
      } else {
        reject(new ClaudeError(`Ошибка запуска: ${err.message}`, "SPAWN_FAILED", err));
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;

      if (killed) {
        reject(
          new ClaudeError(
            `Claude превысил таймаут ${opts.timeoutMs}мс`,
            "TIMEOUT",
            { stderr, durationMs },
          ),
        );
        return;
      }

      if (code !== 0) {
        let prettyMessage = `Claude завершился с кодом ${code}`;
        let resolvedCode: ClaudeError["code"] = "NON_ZERO_EXIT";
        try {
          const parsedErr = JSON.parse(stdout) as RawClaudeJson;
          if (parsedErr.result || parsedErr.message) {
            prettyMessage = parsedErr.result ?? parsedErr.message ?? prettyMessage;
            const apiStatus = parsedErr.api_error_status ?? 0;
            resolvedCode =
              apiStatus === 404
                ? "MODEL_NOT_FOUND"
                : apiStatus === 401 || apiStatus === 403
                  ? "UNAUTHORIZED"
                  : "MODEL_ERROR";
          }
        } catch {}
        reject(
          new ClaudeError(prettyMessage, resolvedCode, {
            exitCode: code,
            stderr,
            stdout,
            durationMs,
          }),
        );
        return;
      }

      let parsed: RawClaudeJson;
      try {
        parsed = JSON.parse(stdout) as RawClaudeJson;
      } catch {
        reject(
          new ClaudeError("Claude вернул невалидный JSON", "INVALID_JSON", { stdout, stderr }),
        );
        return;
      }

      if (parsed.is_error) {
        const apiStatus = parsed.api_error_status ?? 0;
        const resultText = parsed.result ?? parsed.message ?? "(no result)";
        const errCode =
          apiStatus === 404
            ? "MODEL_NOT_FOUND"
            : apiStatus === 401 || apiStatus === 403
              ? "UNAUTHORIZED"
              : "MODEL_ERROR";
        reject(
          new ClaudeError(resultText, errCode as ClaudeError["code"], { apiStatus, raw: parsed }),
        );
        return;
      }

      const result = parsed.result ?? parsed.message ?? stdout.trim();
      const usage = parsed.usage;
      promiseResolve({
        result,
        sessionId: parsed.session_id,
        model,
        durationMs,
        costUsd: parsed.total_cost_usd,
        usage: usage
          ? {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              cacheReadTokens: usage.cache_read_input_tokens,
              cacheWriteTokens: usage.cache_creation_input_tokens,
            }
          : undefined,
        isError: false,
      });
    });
  });
}
