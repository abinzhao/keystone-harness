import { TraeCliError } from "./errors.ts";
import { JsonlDecoder, ExecEvents, decodeModels, safeModelName } from "./codec.ts";
import { createTransport, executeTransport, type CliTransport } from "./transport.ts";
import type { CompatibilityResult, TraeCliModelOptions, TraeCliOptions, ProbeOptions, TraeCliRequest, TraeCliResponse } from "./types.ts";

function utf8(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new TraeCliError("protocol"); }
}
async function compatibility(transport: CliTransport, options: TraeCliOptions & ProbeOptions): Promise<CompatibilityResult> {
  if (typeof options.authorizeTransport !== "function") throw new TraeCliError("authorization");
  const version = utf8(await transport.prepare("version", ["--version"]).execute(options.authorizeTransport, options.signal)).trim();
  if (!/^(?:traecli|trae-cli|traex) 0\.210\.1(?:\r?\ninstallation: (?:internal|public|unknown))?$/.test(version)) {
    throw new TraeCliError("unsupported_version");
  }
  const help = utf8(await transport.prepare("help", ["exec", "--help", "--json", "--output-schema", "/dev/null",
    "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "--sandbox", "read-only", "--disallowed-tool", "Bash", "--color", "never"])
    .execute(options.authorizeTransport, options.signal));
  for (const flag of ["--json", "--output-schema", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "--skip-git-repo-check", "--disallowed-tool", "--sandbox", "--model"]) {
    if (!new RegExp(flag + "(?:\\s|$)").test(help)) throw new TraeCliError("unsupported_version");
  }
  return Object.freeze({
    compatible: true, version: "0.210.1", platform: "darwin", cliPath: transport.cliPath,
    cliDigest: transport.cliDigest, confinement: "macos-seatbelt-connect-sni", structuredOutput: true,
    nativeTools: false, authentication: "not-verified", transportPolicy: transport.policy,
    egressHosts: Object.freeze([...options.egressHosts]),
  });
}
export async function probeTraeCli(options: TraeCliOptions & ProbeOptions): Promise<CompatibilityResult> {
  const transport = await createTransport(options);
  return compatibility(transport, options);
}
export async function discoverTraeCliModels(options: TraeCliOptions & ProbeOptions): Promise<readonly { modelName: string; displayName: string }[]> {
  const transport = await createTransport(options);
  await compatibility(transport, options);
  const stdout = await executeTransport(transport, "models", ["models", "--json"], "", options.authorizeTransport, options.signal);
  try { return decodeModels(JSON.parse(utf8(stdout))); }
  catch (error) { throw error instanceof TraeCliError ? error : new TraeCliError("protocol"); }
}
export interface TraeCliAdapter {
  readonly descriptor: {
    readonly id: string; readonly kind: "cloud"; readonly provider: string; readonly modelName: string;
    readonly endpointHost: string; readonly protocol: "trae-cli-exec";
    readonly capabilities: {
      readonly nativeTools: false; readonly structuredOutput: true; readonly streaming: false;
      readonly multimodal: false; readonly contextTokens: number;
    };
    readonly dataEgress: { readonly classes: readonly ("public" | "internal" | "sensitive")[]; readonly local: false };
  };
  readonly compatibility: CompatibilityResult;
  readonly transportPolicy: CompatibilityResult["transportPolicy"];
  complete(request: TraeCliRequest): Promise<TraeCliResponse>;
}
export async function createTraeCliAdapter(options: TraeCliModelOptions): Promise<TraeCliAdapter> {
  if (!safeModelName(options.modelName) || (options.id !== undefined && !safeModelName(options.id))) {
    throw new TraeCliError("configuration");
  }
  const transport = await createTransport(options);
  const checked = await compatibility(transport, options);
  const modelName = options.modelName;
  const onIsolationViolation = options.onIsolationViolation;
  let isolated = false;
  const descriptor = Object.freeze({
    id: options.id ?? "trae-cli:" + modelName, kind: "cloud" as const, provider: "trae-cli",
    modelName, endpointHost: options.endpointHost, protocol: "trae-cli-exec" as const,
    capabilities: Object.freeze({
      nativeTools: false as const, structuredOutput: true as const,
      streaming: false as const, multimodal: false as const, contextTokens: 4096,
    }),
    dataEgress: Object.freeze({ classes: Object.freeze(["public", "internal", "sensitive"] as const), local: false as const }),
  });
  return {
    descriptor, compatibility: checked, transportPolicy: transport.policy,
    async complete(request) {
      if (isolated) throw new TraeCliError("isolation_violation");
      await transport.check(true);
      if (request.signal?.aborted) throw new TraeCliError("cancelled");
      if (typeof request.authorizeTransport !== "function") throw new TraeCliError("authorization");
      if (!request.jsonMode || request.tools.length || request.maxTokens !== undefined || request.temperature !== undefined ||
          !Array.isArray(request.messages) || request.messages.length > 256) throw new TraeCliError("configuration");
      let inputBytes = 0;
      const bounded = (text: string) => {
        inputBytes += Buffer.byteLength(text);
        if (inputBytes > transport.limits.maxInputBytes) throw new TraeCliError("input_limit");
        return text;
      };
      const messages = request.messages.map((message) => {
        if (!["system", "user", "assistant"].includes(message.role)) throw new TraeCliError("configuration");
        if (typeof message.content === "string") return { role: message.role, content: bounded(message.content) };
        const parts = message.content as readonly { readonly type: string; readonly text?: string }[];
        if (!Array.isArray(parts) || parts.length > 256 || parts.some((part) => part.type !== "text" || typeof part.text !== "string")) {
          throw new TraeCliError("configuration");
        }
        return { role: message.role, content: parts.map((part) => bounded(part.text!)).join("\n") };
      });
      const stdin = "Keystone model transport. Return only the final JSON action envelope. " +
        "Tools are described as text; do not execute tools. Conversation data:\n" + JSON.stringify(messages);
      const args = ["exec", "--json", "--model", modelName, "--ephemeral", "--ignore-user-config",
        "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never"];
      for (const feature of ["hooks", "plugins", "multi_agent", "multi_agent_v2", "shell_tool", "shell_snapshot",
        "skill_search", "skill_mcp_dependency_install", "computer_use", "browser_use", "browser_use_external",
        "apps", "code_mode_host", "memories", "prevent_idle_sleep", "unbounded_connection_retries"]) {
        args.push("--disable", feature);
      }
      // Flag semantics are defense in depth. Seatbelt and output refusal, not
      // these names or the prompt, enforce the process boundary.
      for (const tool of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Task"]) {
        args.push("--disallowed-tool", tool);
      }
      const decoder = new JsonlDecoder(transport.limits.maxOutputBytes, transport.limits.maxFrameBytes);
      const events = new ExecEvents({ codeModeHostDisabled: true });
      try {
        await executeTransport(transport, "generate", args, stdin, request.authorizeTransport, request.signal, (chunk) => {
          for (const frame of decoder.push(chunk)) events.accept(frame);
        });
      } catch (error) {
        if (error instanceof TraeCliError && error.code === "isolation_violation") {
          isolated = true;
          try { onIsolationViolation?.("isolation_violation"); } catch { /* Lifecycle notification cannot replace refusal. */ }
        }
        throw error;
      }
      decoder.finish();
      const result = events.finish();
      return { ...result, toolCalls: [] as const, modelName, finishReason: "stop" };
    },
  };
}
