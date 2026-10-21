/**
 * Per-workspace start policy (ADR-0013 Decision D).
 *
 * A workspace may carry `<root>/.keystone/policy.json` that tightens startup
 * behaviour for that project only:
 *
 *   { "confirmAllWrites": true, "allowAutoStartForLowRisk": false }
 *
 * It is read server-side, so a shell cannot waive it. It can only *tighten* —
 * there is no field here that loosens the default, because loosening would be
 * an envelope widening and only a recorded user decision may do that.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_START_POLICY, type StartPolicy } from "./start-risk.ts";

const POLICY_REL_PATH = join(".keystone", "policy.json");

export interface ProjectPolicyFile {
  readonly confirmAllWrites?: boolean;
  readonly allowAutoStartForLowRisk?: boolean;
}

/**
 * Resolve the effective policy for a submission. `userConfirmAllWrites` is the
 * workbench toggle (a presentation preference, sent by the client); the project
 * file is authoritative for the workspace. The result is a tightening union.
 */
export async function resolveStartPolicy(
  workspacePath: string,
  userConfirmAllWrites: boolean,
): Promise<StartPolicy> {
  const project = await readProjectPolicy(workspacePath);
  return {
    // Either source demanding confirmation forces it.
    confirmAllWrites: userConfirmAllWrites,
    projectConfirmAllWrites: project.confirmAllWrites === true,
    // The project file is the only thing that can disable auto-start.
    allowAutoStartForLowRisk:
      project.allowAutoStartForLowRisk === undefined ? true : project.allowAutoStartForLowRisk,
  };
}

async function readProjectPolicy(workspacePath: string): Promise<ProjectPolicyFile> {
  try {
    const raw = await readFile(join(workspacePath, POLICY_REL_PATH), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(typeof parsed["confirmAllWrites"] === "boolean"
        ? { confirmAllWrites: parsed["confirmAllWrites"] }
        : {}),
      ...(typeof parsed["allowAutoStartForLowRisk"] === "boolean"
        ? { allowAutoStartForLowRisk: parsed["allowAutoStartForLowRisk"] }
        : {}),
    };
  } catch {
    // No policy file (or an unreadable one) means the project takes the
    // shipped defaults — a missing file is not an error.
    return {};
  }
}

/** Re-exported so callers do not need to import the module for the constant. */
export { DEFAULT_START_POLICY };
