# Future Agent Foundation: Evidence Note

- **Document date**: 2026-10-20
- **Nature**: External-trend evidence for the [universal-foundation architecture](../architecture/2026-10-20-keystone-universal-foundation.md)
- **Sourcing rule**: only official, first-party, or primary sources are cited for dated claims (protocol sites, official product docs, the original essay/paper). Aggregators and secondary commentary are excluded.
- **Evidence vs projection**: Part A lists trends that are *verifiably true today*. Part B lists 2027–2030 projections, explicitly labeled as opinion — they are not evidence and carry a falsification condition each.

## Part A — Verified public trends (as of 2026-10-20)

Each item is a fact about something that exists today, with the canonical source.

### A1. Agent interoperability is converging on open protocols

- **MCP (Model Context Protocol)** is an open JSON-RPC protocol for connecting LLM apps to tools and data sources; the spec is versioned and public (the 2026-07-28 revision added a stateless core and a formal extensions framework). Source: https://modelcontextprotocol.io/specification/2025-06-18/basic and https://blog.modelcontextprotocol.io/posts/2026-07-28/
- **A2A (Agent2Agent)** is an open agent-to-agent protocol, originally developed at Google and now donated to the Linux Foundation. Source: https://a2a-protocol.org/latest/
- **ACP (Agent Client Protocol)** is an open IDE↔agent standard introduced by Zed; a public registry lets one agent implementation appear in every ACP client. Sources: https://zed.dev/acp , https://zed.dev/blog/acp-registry , https://zed.dev/blog/bring-your-own-agent-to-zed

**Implication:** the seam Keystone controls (the Run Protocol for contract/lease/proof) sits *above* these transport protocols; adopting them at their intended boundaries is safe, but none of them supplies a completion or evidence semantics.

### A2. On-demand, filesystem-based capability packaging is becoming standard

- **Agent Skills** are reusable, filesystem-based resources that a generalist agent loads on demand for domain expertise; they are documented as a first-class extension surface. Source: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview

**Implication:** "cognition is packaged and loaded on demand" is now the mainstream shape. Keystone's governed extensions (manifest + integrity + conformance) are the trust layer around exactly this idea.

### A3. Local-first and local open-model runtimes are mainstream enough to build on

- The **local-first** principle — offline-first, user-owned data, no dependence on a central service — was articulated in a widely cited 2019 essay defining seven ideals (fast, multi-device, offline, collaboration, longevity, portability, and usability). Source: https://www.inkandswitch.com/essay/local-first/
- **Local open-model runtimes** (e.g. Ollama) run open models on user hardware and expose an OpenAI-compatible endpoint, so a client that speaks the OpenAI-compatible wire works unchanged on local models. Source: https://ollama.com/

**Implication:** Keystone's local-first posture (runtime data under `~/.keystone/`, no vendor lock-in, OpenAI-compatible adapters) aligns with a durable movement, not a transient fad.

### A4. The credible judge is evidence/tests, not the model's self-report

- **SWE-bench** evaluates coding agents on real GitHub issues, accepting a patch only when the repository's own fail-to-pass tests go green; a human-validated "Verified" subset exists for reliable comparison. Sources: https://www.swebench.com/ , https://www.swebench.com/verified , paper https://arxiv.org/abs/2310.06770

**Implication:** Keystone's core bet — completion is a deterministic query over independent evidence, and a model claim cannot satisfy a completion condition — is the same principle the field's credible benchmarks already rely on.

### A5. Provider wire formats are converging on the OpenAI-compatible shape

- OpenAI's developer surface has converged on the Responses API alongside Chat Completions; OpenAI-compatible endpoints (cloud and local) are the de facto interoperable wire, which is why local runtimes can reuse it. Source: https://platform.openai.com/docs

**Implication:** a thin OpenAI-compatible adapter is a durable, low-lock-in choice. Native Responses, native tool-calling, and Anthropic/Gemini native endpoints have since been implemented as v1 adapters (ADR-0010, mock-tested in-process; the Builder Loop still drives the text envelope and no live provider call has been made).

## Part B — 2027–2030 projections (opinion, not evidence)

These are Keystone's directional bets. They are **not** verified facts; each carries a falsification condition.

| # | Projection (2027–2030) | Why we believe it | Falsification condition |
|---|---|---|---|
| P1 | The market splits into a thin client layer and a small number of stable, auditable runtimes; agents stop being single monolithic chat apps. | A1–A2 show protocol and capability packaging already decoupling cognition from the client. | If closed clients keep winning without exposing stable runtimes or open protocols. |
| P2 | On-device / local models become good enough for a large share of routine engineering work, making local-first the default for privacy-sensitive teams. | A3 shows local runtimes and local-first principles already mainstream. | If frontier model gains concentrate exclusively in cloud-only services and local models fall meaningfully behind on the relevant tasks. |
| P3 | Completion, proof, and signed replay become portable artifacts that travel across machines and teams. | A4 shows independent, evidence-based judging is becoming the norm; A1 shows agents starting to talk to each other. | If proof/audit stays a vendor-internal feature with no open, replayable format. |
| P4 | Multi-agent collaboration becomes routine, but only when provenance, permissions, and evidence carry across the boundary. | A1 shows A2A/ACP standardising transport; A2 shows on-demand expertise packaging. | If agents interoperate by sharing prompts/context only, with no way to carry leases or evidence across the seam. |

## Boundaries and refresh

- Part A cites only official/first-party/primary sources as of 2026-10-20; no product is described as "leading" without a reproducible scorecard.
- Part B is direction, not a commitment; it is revisited when a Part-A fact changes (e.g. a new protocol revision, a new benchmark result, or a major provider wire change).
- This note makes no measured claims about any specific product's performance; such numbers are added only after public, reproducible experiments.
