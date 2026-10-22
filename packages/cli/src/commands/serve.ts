/**
 * `keystone serve` — expose the runtime to a shell over the Run Protocol.
 *
 * This is the seam a desktop workbench, an editor or a CI runner uses. It is not
 * a second implementation of anything: the same `KeystoneRuntime`, the same
 * schemas, the same ledger (PRD 1.4, ST-03).
 *
 * The server binds to loopback and requires a bearer token generated at start.
 * The token is printed once, and the workbench URL carries it in the URL
 * fragment — fragments are not sent to servers, so it stays out of logs and
 * `Referer` headers. There is deliberately no flag to disable authentication: a
 * local process that can run commands must not be reachable by any page that
 * happens to guess the port.
 */

import { DEFAULT_LANGUAGE } from "@keystone/i18n";
import {
  enabledModels,
  loadConfig,
  routeFor,
  type ModelAdapter,
  type ModelRole,
} from "@keystone/models";
import { startServer, ModelPluginService, buildRuntimeAdapter } from "@keystone/runtime";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";

import { getBoolean, getString, parseArgs } from "../args.ts";
import { createOutput } from "../output.ts";
import { loadScriptedFixture } from "./task.ts";
import { credentialsFor, pathsFor, translatorForContext, type CliContext, type CommandModule } from "./shared.ts";

const MODES = ["minimal", "standard", "isolated", "replay"] as const;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const command: CommandModule = {
  name: "serve",
  summary: (t) => t("Serve the runtime to a local shell over the Keystone Run Protocol"),
  usage: "keystone serve [--port <n>] [--mode <mode>] [--model <id>] [--json]",

  help: [
    "Usage: keystone serve [options]",
    "",
    "Options:",
    "  --port <n>       Port to listen on, loopback only (default: an ephemeral port)",
    "  --mode <mode>    minimal | standard | isolated | replay (default: standard)",
    "  --model <id>     Use only this configured model",
    "  --json           Print the startup record as JSON",
    "",
    "Listens on 127.0.0.1 only and requires the bearer token printed at startup.",
    "Open the printed workbench URL; its fragment carries the token, which",
    "browsers never send to a server.",
    "",
    "Endpoints (all need the token):",
    "  GET  /v1/capabilities          protocol version, mode, capability negotiation",
    "  GET  /v1/tasks                 persisted tasks with status and stage",
    "  GET  /v1/tasks/:id             contract, evidence, branches, replay check",
    "  GET  /v1/tasks/:id/events      ledger events, optionally ?since=<seq>",
    "  GET  /v1/tasks/:id/proof       the machine-readable proof package",
    "  GET  /v1/tasks/:id/diff        the change set, recomputed from the repository",
    "  GET  /v1/tasks/:id/checkpoints the restore points a run can resume from",
    "  GET  /v1/tasks/:id/run         this server session's run state and open decisions",
    "  GET  /v1/data                  what is stored locally, with sizes",
    "  POST /v1/tasks                 start a task; returns 202 with the task id",
    "  POST /v1/tasks/:id/decisions   answer an open intervention",
    "  POST /v1/tasks/:id/contract    revise the contract of a running task (queued)",
    "  POST /v1/tasks/:id/control     pause or stop a task (queued while it runs)",
    "  POST /v1/projects/:id/experience/clear   drop a project's experience cache",
    "  DELETE /v1/tasks/:id           delete a task's stored history",
    "",
  ].join("\n"),

  async run(argv: readonly string[], context: CliContext): Promise<number> {
    const args = parseArgs(argv, {
      flags: {
        json: "boolean",
        port: "string",
        mode: "string",
        model: "string",
        "scripted-fixture": "string",
      },
    });

    const modeValue = getString(args, "mode") ?? "standard";
    if (!(MODES as readonly string[]).includes(modeValue)) {
      throw new Error(
        `unknown mode "${modeValue}"; expected one of ${MODES.join(", ")}`,
      );
    }
    const mode = modeValue as (typeof MODES)[number];
    const output = createOutput({ stdout: context.stdout, stderr: context.stderr, json: getBoolean(args, "json") });
    const t = translatorForContext(context);

    const portValue = getString(args, "port");
    const port = portValue === undefined ? undefined : Number(portValue);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
      throw new Error(`--port must be a port number, got "${String(portValue)}"`);
    }

    const paths = pathsFor(context);
    const config = await loadConfig({ configFile: paths.configFile });
    const credentials = credentialsFor(context);

    const requested = getString(args, "model");
    const fixture = getString(args, "scripted-fixture");
    const adapters: ModelAdapter[] = [];
    if (fixture !== undefined) {
      // The same offline entry point the CLI has, so a workbench can be
      // evaluated and demonstrated without a key or a network (PRD EX-05).
      const responses = await loadScriptedFixture(fixture);
      adapters.push(
        createSequenceAdapter({
          descriptor: scriptedModelDescriptor({ id: requested ?? "scripted" }),
          responses,
        }),
      );
      output.line(
        t("Using the built-in scripted model: deterministic, offline execution (tests / evaluation, PRD EX-05)."),
      );
    } else {
      for (const entry of enabledModels(config)) {
        if (requested !== undefined && entry.id !== requested) continue;
        try {
          adapters.push(buildRuntimeAdapter(entry, credentials, new ModelPluginService(paths)));
        } catch (error) {
          output.error(t('skipping model "{id}": {message}', { id: entry.id, message: messageOf(error) }));
        }
      }
    }

    const routes: Partial<Record<ModelRole, readonly string[]>> =
      requested === undefined
        ? {
            builder: routeFor(config, "builder"),
            summarizer: routeFor(config, "summarizer"),
            planner: routeFor(config, "planner"),
          }
        : { builder: [requested], summarizer: [requested], planner: [requested] };

    if (adapters.length === 0) {
      // Serve anyway: browsing existing tasks and proofs is useful without a
      // model, and starting a task will fail with the model's own explanation.
      output.error(
        t("No usable model is configured, so tasks started from the workbench will fail at their first"),
      );
      output.error(
        t("model call. Configure one with `keystone model add ...` and `keystone model credential set <handle>`."),
      );
    }

    const server = await startServer({
      paths,
      credentials,
      models: adapters,
      routes,
      mode,
      language: context.language ?? DEFAULT_LANGUAGE,
      ...(port === undefined ? {} : { port }),
    });

    const workbenchUrl = `${server.url}#t=${server.token}`;

    if (getBoolean(args, "json")) {
      output.json({
        protocolVersion: server.protocolVersion,
        port: server.port,
        url: server.url,
        workbenchUrl,
        token: server.token,
        mode,
        models: adapters.map((adapter) => adapter.descriptor.id),
      });
    } else {
      output.section(t("Keystone Run Protocol server"));
      output.keyValue({
        [t("protocol")]: server.protocolVersion,
        [t("listening")]: `127.0.0.1:${server.port}`,
        [t("mode")]: mode,
        [t("models")]: adapters.map((adapter) => adapter.descriptor.id).join(", ") || t("(none configured)"),
      });
      output.line("");
      output.section(t("Workbench"));
      output.line(workbenchUrl);
      output.line("");
      output.line(t("Bearer token: {token}", { token: server.token }));
      output.line("");
      output.line(t("Press Ctrl+C to stop."));
    }

    await new Promise<void>((resolve) => {
      const stop = (): void => {
        void server.close().then(() => {
          resolve();
        });
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });

    output.line(t("Server stopped."));
    return 0;
  },
};
