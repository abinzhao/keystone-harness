/**
 * The engineering action-resolution policy (ADR-0006, M1).
 *
 * The kernel owns the *decision* to authorise a proposal — scope, Autonomy
 * Envelope, lease issuance/refusal, and the `lease.issued` / `action.rejected`
 * events. It deliberately hard-codes nothing about *how* a model `intent` maps
 * to a Capability, or *how* a tool id maps to the resources it touches. That is
 * scenario/composition policy, and for the software-engineering vertical it
 * lives here, as an `ActionCapabilityResolver` the composition root wires into a
 * `KernelSession`.
 *
 * This module is the exact behaviour that used to be hard-coded in the kernel
 * (`capabilityFor` / `resourceValuesFor`), moved out verbatim:
 *
 *  - `read`/`search` → `fs.read`, `write` → `fs.write`, `delete` → `fs.delete`,
 *    `execute` → `cmd.exec`, `network` → `net.fetch`, `git` → `git.write` only
 *    when the proposal explicitly requested it, else `git.read`; `ask_user` and
 *    `finish` are not leasable (return `undefined`, which makes the kernel
 *    default-deny).
 *  - Built-in tools resolve their own resource from their parameters (`path`,
 *    `glob`, `command`); read-only git tools touch the whole worktree `.`; an
 *    extension-provided tool names what it touches via its declared
 *    `expectedEffects`.
 *
 * It depends downward on `@keystone/kernel` (for the resolver seam) and
 * `@keystone/schemas`; the kernel never imports it. It is pure: no state, no
 * side effects, so it stays replay-safe.
 */

import type { ActionProposal, Capability } from "@keystone/schemas";
import type { ActionCapabilityResolver, ActionResolution } from "@keystone/kernel";

/** Map a proposal to the capability it needs. `undefined` means "not leasable". */
function engineeringCapability(proposal: ActionProposal): Capability | undefined {
  switch (proposal.intent) {
    case "read":
    case "search":
      return "fs.read";
    case "write":
      return "fs.write";
    case "delete":
      return "fs.delete";
    case "execute":
      return "cmd.exec";
    case "network":
      return "net.fetch";
    case "git":
      return proposal.requestedCapabilities.includes("git.write") ? "git.write" : "git.read";
    case "ask_user":
    case "finish":
      return undefined;
  }
}

/** The resources a proposal touches, in the vocabulary the lease understands. */
function engineeringResourceValues(proposal: ActionProposal): readonly string[] {
  const parameters = proposal.parameters;
  const asString = (key: string): string | undefined =>
    typeof parameters[key] === "string" ? (parameters[key] as string) : undefined;

  switch (proposal.tool.id) {
    case "fs.read_file":
    case "fs.write_file":
    case "fs.delete_file":
    case "fs.list_dir": {
      const path = asString("path");
      return path === undefined ? [] : [path];
    }
    case "fs.search_text":
      return [asString("glob") ?? "**"];
    case "cmd.run": {
      const command = asString("command");
      return command === undefined ? [] : [command];
    }
    case "git.status":
    case "git.diff":
    case "git.show_head":
      return ["."];
    case "git.commit": {
      // Path-scoped commit: the lease must cover exactly the paths being committed.
      const paths = Array.isArray(parameters.paths)
        ? parameters.paths.filter((value): value is string => typeof value === "string")
        : [];
      return paths;
    }
    case "git.rollback":
      // A branch-pointer operation spans the whole worktree.
      return ["."];
    default: {
      // An extension-provided tool must still name what it touches, so the
      // proposal's declared effects become the resource list.
      const targets = proposal.expectedEffects
        .map((effect) => effect.target)
        .filter((target) => target !== "");
      return targets;
    }
  }
}

/**
 * The engineering scenario policy for `KernelSession`'s injected resolver seam.
 * Returns the capability (or `undefined` to default-deny) together with the
 * resource values the lease will check against scope and the Autonomy Envelope.
 */
export const resolveEngineeringAction: ActionCapabilityResolver = (
  proposal: ActionProposal,
): ActionResolution => ({
  capability: engineeringCapability(proposal),
  resourceValues: engineeringResourceValues(proposal),
});
