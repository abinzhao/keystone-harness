/**
 * `@keystone/spawn` — generic cross-platform child-process launch compatibility.
 *
 * This is a neutral, zero-dependency bottom layer (ADR-0006, M1). It exists so
 * the generic execution boundaries — `@keystone/tools` (actions) and
 * `@keystone/verifiers` (checks) — can resolve *how* to launch a command on
 * Windows without either of them depending on an engineering scenario pack.
 *
 * It carries no task, contract, scope, or scenario vocabulary: only OS-level
 * process-launch compatibility (`.cmd`/`.bat` shim resolution and `cmd.exe`
 * argument escaping). It never launches a process and never touches authoritative
 * state.
 */

export * from "./spawn-target.ts";
