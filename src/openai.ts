import type { AnthropicBlock, AnthropicMessage } from "./claude.ts";
import type { OpenAIMessage } from "./types.ts";

export interface ConvertedPrompt {
  systemPrompt?: string;
  userPrompt: string;
  hadMultimodal: boolean;
}

/**
 * Convert OpenAI Chat Completions messages into a single prompt suitable for
 * `claude -p <prompt>` plus optional `--system-prompt`.
 *
 * Rules:
 * - All `system` messages are concatenated (double-newline separated) and
 *   passed as `--system-prompt`. Subsequent system messages keep their
 *   semantic order even if interleaved.
 * - The remaining messages are formatted as a "User: ...\nAssistant: ..." log.
 *   The conversation is ended with an empty "Assistant:" line so the model
 *   knows to continue as the assistant.
 * - `image_url` content parts are dropped with a notice — `claude -p` does not
 *   accept images via CLI flags. Callers needing vision should use a real
 *   multimodal provider.
 */
export function openAIToClaudePrompt(
  messages: OpenAIMessage[],
): ConvertedPrompt {
  const systemParts: string[] = [];
  const convoLines: string[] = [];
  let hadMultimodal = false;

  for (const m of messages) {
    const role = m.role;
    const text = messageToText(m.content, (isImage) => {
      if (isImage) hadMultimodal = true;
    });

    if (role === "system" || role === "tool" || role === "function") {
      if (text.trim()) systemParts.push(text.trim());
      continue;
    }

    if (role === "user") {
      convoLines.push(`Human: ${text.trim()}`);
    } else if (role === "assistant") {
      convoLines.push(`Assistant: ${text.trim()}`);
    } else {
      convoLines.push(`${capitalize(role)}: ${text.trim()}`);
    }
  }

  // Claude CLI's `-p` is single-turn. We emulate multi-turn by including the
  // history in the prompt. We strip any trailing "Assistant:" line to avoid
  // echoing it back.
  if (convoLines.length === 0) {
    throw new Error("No user/assistant messages provided");
  }
  const lastIsAssistant =
    convoLines[convoLines.length - 1]?.startsWith("Assistant:");
  if (lastIsAssistant) convoLines.pop();

  const userPrompt = `${convoLines.join("\n\n")}\n\nAssistant:`;
  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    userPrompt,
    hadMultimodal,
  };
}

function messageToText(
  content: OpenAIMessage["content"],
  markImage: (isImage: boolean) => void,
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part.type === "text") {
        parts.push(part.text);
      } else if (part.type === "image_url") {
        markImage(true);
        const url = part.image_url.url;
        if (url.startsWith("data:image/")) {
          const sizeKB = Math.round((url.length * 3) / 4 / 1024);
          parts.push(
            `[image omitted: inline image (~${sizeKB} KB) not supported by claude -p]`,
          );
        } else {
          parts.push(`[image omitted: ${url}]`);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface AnthropicConvertResult {
  systemPrompt?: string;
  messages: AnthropicMessage[];
}

function convertImageUrlToBlock(url: string): AnthropicBlock {
  if (url.startsWith("data:")) {
    const sep = url.indexOf(";base64,");
    if (sep !== -1) {
      return {
        type: "image",
        source: { type: "base64", media_type: url.slice(5, sep), data: url.slice(sep + 8) },
      };
    }
  }
  return { type: "image", source: { type: "url", url } };
}

export function openAIToAnthropicMessages(messages: OpenAIMessage[]): AnthropicConvertResult {
  const sysTexts: string[] = [];
  const turns: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === "system" || m.role === "tool" || m.role === "function") {
      const t =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((p) => p.type === "text")
                .map((p) => (p as { type: "text"; text: string }).text)
                .join("\n")
            : "";
      if (t.trim()) sysTexts.push(t.trim());
      continue;
    }

    const role: "user" | "assistant" = m.role === "user" ? "user" : "assistant";
    const blocks: AnthropicBlock[] = [];

    if (typeof m.content === "string") {
      if (m.content) blocks.push({ type: "text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "text") {
          blocks.push({ type: "text", text: p.text });
        } else if (p.type === "image_url") {
          blocks.push(convertImageUrlToBlock(p.image_url.url));
        }
      }
    }

    if (blocks.length > 0) turns.push({ role, content: blocks });
  }

  while (turns.length > 0 && turns[turns.length - 1]?.role === "assistant") turns.pop();
  if (turns.length === 0) throw new Error("No user/assistant messages provided");

  return {
    systemPrompt: sysTexts.length > 0 ? sysTexts.join("\n\n") : undefined,
    messages: turns,
  };
}
