# ADR-0004: TypeScript Kernel with Zero Runtime Dependencies

- **Status**: Accepted
- **Date**: 2026-10-19
- **Decision basis**: `需求文档.md` Sections 1.4, 8.2 (OT-04), 11.4, 12.5, 12.6

## Context

The PRD requires: Schemas are public and versioned, derived code is generated from authoritative Schemas (NFR-COMP-05), the extension SDK targets models/tools/verifiers/protocol adapters, support for Node-ecosystem-friendly protocols such as MCP and ACP, local-first and offline-capable, and a Minimal Runtime that still works when all third-party extensions are unavailable (12.6).

At the same time, this project is an **early-stage open-source project developed by a single person**; the deeper the dependency tree, the higher the supply-chain risk (PRD 11.7) and maintenance cost.

## Decision

1. **Implementation language: TypeScript**, running on Node.js. All packages are `"type": "module"`.
2. **Zero runtime dependencies**: the production code of `packages/*` uses only Node built-in modules (`node:fs`, `node:child_process`, `node:crypto`, `node:path`, etc.). Third-party dependencies are used only as devDependencies for type checking.
3. **No build step is introduced**: `.ts` source files are executed directly. Node ≥ 22.18 enables type stripping by default. For this reason `erasableSyntaxOnly` is enforced, which prohibits non-erasable syntax such as `enum`, `namespace`, constructor parameter properties and decorator metadata.
4. **Relative imports must explicitly include the `.ts` extension**, which is a hard requirement of Node ESM resolution plus type stripping.
5. **Tests use the built-in `node:test` + `node:assert/strict`**, with no test framework introduced. Note that `node --test` requires a glob argument (a directory argument will not discover `.ts` test files).
6. **Schemas are hand-written as TypeScript types + runtime validators**, with no `zod` / `ajv` etc. introduced. The validator is at the same time the "authoritative source of the Schema", and the exported JSON representation is used for cross-language consumption.
7. **Packages reference each other via pnpm workspace symlinks**. Empirically: Node refuses to type-strip `.ts` inside a real `node_modules` directory (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), but it works with pnpm symlinks (whose real paths are outside `node_modules`). Therefore packages within the workspace must use the `workspace:*` protocol, and dependencies must be symlinks rather than real directories.

## Consequences

- The supply-chain attack surface and installation size are significantly reduced; offline use is available; `git clone && node packages/cli/src/bin.ts` just works.
- Contributors are required to use Node ≥ 22.18; the contribution docs must state this explicitly.
- `enum` cannot be used. States, evidence levels, etc. are expressed with `as const` objects + union types, which is also more conducive to serialization and Schema generation.
- If some capability in the future (such as sandbox isolation or SQLite indexing) genuinely needs a native dependency, it should be introduced as an **optional extension** and be degradable, rather than entering the kernel's dependency tree.

## Rejected Alternatives

- **Introducing `zod` / `ajv` for validation**: would bind the Schema source of truth to a third-party library's DSL and version, conflicting with NFR-COMP-05 "derived code is generated from authoritative Schemas".
- **Introducing `vitest` / `jest`**: more powerful but with a huge dependency tree; `node:test` is sufficient to cover kernel unit and integration tests. If coverage or snapshot capabilities are needed in the future, re-evaluate then.
- **A Rust kernel**: better performance and process isolation, but would require extra bridging for the Schema/SDK/protocol ecosystem, significantly slowing development. It has been retained as an option for pushing down future hot modules such as "indexing and sandboxing".
