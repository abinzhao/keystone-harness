import { tr } from "../components/dom.js";

// Only exact built-in templates are localized. Arbitrary model prose remains unchanged.
export function interventionText(value = "", trigger = "") {
  if (trigger === "ambiguity") return value;
  const patterns = [
    [/^Allow (.+)$/, "Allow {target}", "target"],
    [/^Keystone needs to (.+) to continue, which is outside what this task is allowed to touch\. Allow it\?$/, "Keystone needs access to {target} outside the current task scope. Allow it?", "target"],
    [/^the task will stop or look for an alternative that keeps (.+) achievable without this change$/, "Without this permission, the task stops or seeks an alternative for: {goal}", "goal"],
    [/^no change; Keystone will stay within (\d+) declared pattern\(s\)$/, "No change; stay within {count} declared patterns", "count"],
    [/^reading (.+) is outside the project's read boundary$/, "Reading {target} is outside this project's read boundary.", "target"],
    [/^writing (.+) is outside the project's write boundary$/, "Writing {target} is outside this project's write boundary.", "target"],
    [/^"(.+)" is not among the commands this project allows$/, "Command {target} is not allowed for this project.", "target"],
    [/^"(.+)" is not an allowed network destination$/, "Host {target} is not an allowed network destination.", "target"],
    [/^Extend the project's write boundary to cover (.+)$/, "Extend the project write boundary to include {target}.", "target"],
    [/^Extend the task scope to cover (.+)$/, "Extend the task scope to include {target}.", "target"],
  ];
  for (const [pattern, key, parameter] of patterns) {
    const match = pattern.exec(value);
    if (match) return tr(key, { [parameter]: match[1] });
  }
  const known = new Set([
    "Find an alternative inside the current scope", "Stop and hand back what has been verified so far",
    "as recommended by the system", "no change beyond the current budget", "may consume additional retries",
    "no change", "stops spending immediately", "this is the smallest change that unblocks the task",
    "The task budget is exhausted. Continue with more budget?",
    "the task will exit with whatever is currently verified", "Raise the budget", "the current attempt is out of resources",
    "Exit with what is verified so far", "the task cannot proceed without this decision",
    "Some completion conditions could not be evaluated. How should Keystone proceed?",
    "the task cannot be proven; it will exit with the unverified conditions listed",
    "Provide or agree on the missing verification command", "a condition without a runnable check cannot be proven",
    "Run this reviewed extension process in its copied workspace?",
    "Starting extension code requires confirmation of this exact operation.",
    "This extension operation will remain unavailable; no code is launched.",
    "Run this operation once", "The displayed parameters and resource are fixed for this call.",
    "this action cannot be undone, so automatic approval never covers it",
    "Confirm this specific action, naming the exact resource",
    "the request was derived from content Keystone does not trust, and untrusted content cannot authorise data leaving the machine",
    "Review the source and confirm the outbound action explicitly",
    "this project permits no writes to external systems",
  ]);
  return known.has(value) ? tr(value) : value;
}

export function interventionChoice(option, intervention) {
  if ((option.grants?.length ?? 0) > 1) return null;
  if (option.optionId === intervention.recommendedAction?.optionId || option.grants?.length === 1) return "allow";
  if (option.label === "Find an alternative inside the current scope") return "deny";
  if (option.label === "Exit with what is verified so far") return "deny";
  if (option.label === "Stop and hand back what has been verified so far") return "stop";
  if (intervention.trigger === "ambiguity" && !option.widensEnvelope && !option.grants?.length) return "modify";
  return null;
}
