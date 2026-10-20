/**
 * `@keystone/pack-engineering` — the software-engineering reference scenario pack.
 *
 * This is the first vertical stood on the trusted kernel (ADR-0006). It owns
 * engineering-only vocabulary that must not leak into `@keystone/kernel`:
 *
 *  - Git work-tree scanning and project profiling (`scan/workspace.ts`);
 *  - the engineering Outcome-Contract proposal heuristics (`contract/compile.ts`);
 *  - the engineering action→capability/resource policy (`lease/resolve.ts`).
 *
 * Cross-platform Windows spawn-target resolution used to live here too, but it
 * is generic process-launch compatibility, not engineering vocabulary — it now
 * ships in the neutral `@keystone/spawn`, which both execution boundaries
 * (`@keystone/tools`, `@keystone/verifiers`) depend on without touching this pack
 * (ADR-0006, M1).
 *
 * The pack depends downward on `@keystone/kernel` and `@keystone/schemas`; the
 * kernel never imports it, so the kernel stays replayable standalone. Everything
 * here *proposes* or *resolves* — it never writes authoritative state.
 */

export * from "./scan/workspace.ts";
export * from "./contract/compile.ts";
export * from "./lease/resolve.ts";
