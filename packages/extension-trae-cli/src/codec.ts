import { TraeCliError } from "./errors.ts";

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TraeCliError("protocol");
  return value as Record<string, unknown>;
}

export class JsonlDecoder {
  readonly maxBytes: number;
  readonly maxFrameBytes: number;
  private total = 0;
  private pending = Buffer.alloc(0);
  private ended = false;
  constructor(maxBytes: number, maxFrameBytes: number) {
    this.maxBytes = maxBytes;
    this.maxFrameBytes = maxFrameBytes;
  }
  push(chunk: Uint8Array): Record<string, unknown>[] {
    if (this.ended) throw new TraeCliError("protocol");
    this.total += chunk.byteLength;
    if (this.total > this.maxBytes) throw new TraeCliError("output_limit");
    const frames: Record<string, unknown>[] = [];
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index++) {
      if (chunk[index] !== 10) continue;
      const part = chunk.subarray(start, index);
      if (this.pending.byteLength + part.byteLength > this.maxFrameBytes) throw new TraeCliError("output_limit");
      const bytes = Buffer.concat([this.pending, part]);
      this.pending = Buffer.alloc(0);
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
        if (text !== "") frames.push(record(JSON.parse(text)));
      } catch (error) {
        if (error instanceof TraeCliError) throw error;
        throw new TraeCliError("protocol");
      }
      start = index + 1;
    }
    if (this.pending.byteLength + chunk.byteLength - start > this.maxFrameBytes) throw new TraeCliError("output_limit");
    this.pending = Buffer.concat([this.pending, chunk.subarray(start)]);
    return frames;
  }
  finish(): void {
    this.ended = true;
    if (this.pending.byteLength !== 0) throw new TraeCliError("protocol");
  }
}

export interface MeasuredUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TraeCliError("protocol");
  return value;
}

// This is a transport container, not an ActionProposal validator or authority.
// The runtime validates each action with the existing model envelope schema.
export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "actions"],
  properties: {
    summary: { type: "string", maxLength: 2000 },
    answer: { type: "string", maxLength: 65536 },
    actions: { type: "array", maxItems: 16, items: { type: "object" } },
    needs_user: {
      type: "object", additionalProperties: false, required: ["question", "why", "options"],
      properties: {
        question: { type: "string", minLength: 1 },
        why: { type: "string", minLength: 1 },
        options: { type: "array", maxItems: 8, items: { type: "string", minLength: 1 } },
      },
    },
  },
} as const;

function envelope(text: string): string {
  try {
    const value = record(JSON.parse(text));
    if (Object.keys(value).some((key) => !["summary", "answer", "actions", "needs_user"].includes(key)) ||
        typeof value["summary"] !== "string" || value["summary"].length > 2000 ||
        (value["answer"] !== undefined && (typeof value["answer"] !== "string" || value["answer"].length > 65536)) ||
        !Array.isArray(value["actions"]) || value["actions"].length > 16) throw new TraeCliError("protocol");
    for (const action of value["actions"]) record(action);
    if (value["needs_user"] !== undefined) {
      const needs = record(value["needs_user"]);
      if (value["actions"].length !== 0 || Object.keys(needs).some((key) => !["question", "why", "options"].includes(key)) ||
          typeof needs["question"] !== "string" || !needs["question"] ||
          typeof needs["why"] !== "string" || !needs["why"] ||
          !Array.isArray(needs["options"]) || needs["options"].length > 8 ||
          needs["options"].some((option) => typeof option !== "string" || !option)) throw new TraeCliError("protocol");
    }
    return JSON.stringify(value);
  } catch {
    throw new TraeCliError("protocol");
  }
}

function nativeError(frame: Record<string, unknown>): never {
  const nested = typeof frame["error"] === "object" && frame["error"] !== null ? record(frame["error"]) : frame;
  const codes: Record<string, "authentication" | "model_unavailable" | "rate_limit" | "quota"> = {
    unauthorized: "authentication", authentication_failed: "authentication",
    model_not_found: "model_unavailable", rate_limit_exceeded: "rate_limit", insufficient_quota: "quota",
  };
  const code = typeof nested["code"] === "string" ? codes[nested["code"]] : undefined;
  throw new TraeCliError(code ?? "cli_failed");
}

export class ExecEvents {
  private finalText: string | undefined;
  private completed = false;
  private usage: MeasuredUsage | undefined;
  private invalidUsage = false;
  private turnStarted = false;
  private startupNoticeSeen = false;
  private readonly codeModeHostDisabled: boolean;
  constructor(options: { readonly codeModeHostDisabled?: boolean } = {}) {
    this.codeModeHostDisabled = options.codeModeHostDisabled === true;
  }
  accept(frame: Record<string, unknown>): void {
    if (this.completed) throw new TraeCliError("protocol");
    const type = frame["type"];
    if (type === "error" || type === "turn.failed") nativeError(frame);
    if (type === "thread.started") return;
    if (type === "turn.started") { this.turnStarted = true; return; }
    if (type === "turn.completed") {
      this.completed = true;
      if (frame["usage"] === undefined) return;
      try {
        const usage = record(frame["usage"]);
        const inputTokens = count(usage["input_tokens"]);
        const outputTokens = count(usage["output_tokens"]);
        const cachedInputTokens = usage["cached_input_tokens"] === undefined ? undefined : count(usage["cached_input_tokens"]);
        if (cachedInputTokens !== undefined && cachedInputTokens > inputTokens) throw new TraeCliError("protocol");
        this.usage = { inputTokens, outputTokens, ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }) };
      } catch {
        this.invalidUsage = true;
      }
      return;
    }
    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      const item = record(frame["item"]);
      // 0.210.1 reports intentionally disabled Code Mode as a startup error
      // item. This exact inert notice grants no host/tool activity or completion.
      if (this.codeModeHostDisabled && !this.turnStarted && !this.startupNoticeSeen && type === "item.completed" &&
          item["type"] === "error" && item["message"] ===
          "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install or update TRAE CLI (`traecli`).") {
        this.startupNoticeSeen = true; return;
      }
      if (item["type"] === "reasoning") return;
      if (item["type"] !== "agent_message") throw new TraeCliError("isolation_violation");
      if (type === "item.completed") {
        if (this.finalText !== undefined || typeof item["text"] !== "string") throw new TraeCliError("protocol");
        this.finalText = item["text"];
      }
      return;
    }
    if (typeof type === "string" && /hook|approval|tool|command|file_change|agent.spawn/.test(type)) {
      throw new TraeCliError("isolation_violation");
    }
    throw new TraeCliError("protocol");
  }
  finish(): { text: string; usage: { inputTokens: number; outputTokens: number }; measuredUsage: MeasuredUsage } {
    if (!this.completed || this.finalText === undefined || this.invalidUsage) throw new TraeCliError("protocol");
    if (this.usage === undefined) throw new TraeCliError("usage_missing");
    return {
      text: envelope(this.finalText),
      usage: { inputTokens: this.usage.inputTokens, outputTokens: this.usage.outputTokens },
      measuredUsage: this.usage,
    };
  }
}

export interface DiscoveredModel {
  readonly modelName: string;
  readonly displayName: string;
}

export function safeModelName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
}

export function decodeModels(value: unknown): DiscoveredModel[] {
  const list = Array.isArray(value) ? value : record(value)["models"];
  if (!Array.isArray(list) || list.length > 256) throw new TraeCliError("protocol");
  const seen = new Set<string>();
  return list.map((entry) => {
    const model = record(entry);
    const name = model["id"] ?? model["model"] ?? model["name"];
    if (!safeModelName(name) || seen.has(name)) throw new TraeCliError("protocol");
    seen.add(name);
    const display = model["display_name"] ?? model["name"] ?? name;
    if (typeof display !== "string" || display.length > 128 ||
        !/^[\p{L}\p{N} ._()+:/-]+$/u.test(display)) throw new TraeCliError("protocol");
    return { modelName: name, displayName: display };
  });
}
