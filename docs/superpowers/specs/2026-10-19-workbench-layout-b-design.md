# Keystone Workbench Layout B Design

- **Status**: Approved
- **Date**: 2026-10-19
- **Decision basis**: `需求文档.md` UI-01 through UI-05
- **Visual reference**: DeepSeek Chat's quiet task-history rail, focused primary surface, and input-led interaction

## 1. Goal

Refine the existing four-zone workbench into a task-focused engineering surface:

- Keep the selected task and its execution flow as the primary visual subject.
- Keep proof status visible without forcing users to inspect raw logs.
- Make starting or revising a task feel as direct as using a modern chat composer.
- Preserve every current workflow, protocol contract, kernel invariant, and localisation capability.

The design borrows interaction economy from DeepSeek Chat, not its product semantics or branding. Keystone remains a task workbench whose authoritative objects are Contract, Run Event, Evidence, and Proof.

## 2. Scope

### In scope

- Reorganise `packages/runtime/web/workbench.html`.
- Restyle the workbench in both light and dark themes.
- Move the page-wide bottom form into a sticky composer in the primary task surface.
- Convert the right side into a compact result inspector with Proof, Evidence, Branches, and Risk views.
- Add responsive collapse rules for the task rail and result inspector.
- Preserve the existing dialogs for diff, contract revision, and local data management.

### Out of scope

- No Runtime API, Run Protocol, Schema, kernel, verifier, or storage change.
- No new task state, completion rule, permission, or Evidence interpretation.
- No framework, runtime dependency, icon package, font, or build step.
- No desktop shell or Tauri work.
- No feature added solely because DeepSeek Chat has it.

## 3. Design Principles

1. **Task first**: the centre surface answers "what is this task trying to achieve, and what is happening now?"
2. **Proof always legible**: the right inspector answers "can this be delivered, and why?"
3. **Governance on exception**: controls remain available, but only pending decisions and delivery blockers demand attention.
4. **Input near context**: new instructions, constraints, and revisions are entered where the current task is read.
5. **Progressive detail**: key events are visible; raw events, hashes, payloads, and full evidence stay collapsible.
6. **State is not colour-only**: every status retains a textual label or icon-plus-label treatment.

## 4. Information Architecture

### 4.1 Wide desktop

At widths of 1180 px and above, the workbench uses three columns:

| Region | Width | Responsibility |
|---|---:|---|
| Task rail | 216-248 px | Project switcher, new task, grouped tasks, cognition and experience summary |
| Task surface | `minmax(520px, 1fr)` | Task header, Outcome Contract, stage, key execution trace, sticky composer |
| Result inspector | 306-336 px | Pending decisions, Proof, Evidence, branches/checkpoints, risks |

The existing top bar is split by ownership instead of spanning the full page:

- Brand and project ownership move into the task rail.
- Selected task, branch, run status, pause, and change actions move into the task header.
- Theme, refresh, protocol, and local-data actions move into a compact overflow/settings area.

### 4.2 Task rail

Order:

1. Keystone brand.
2. Current project selector.
3. Primary "New task" action.
4. Task groups: needs attention, running, waiting, completed, exited.
5. Project cognition, experience cache, and local-data summaries at the bottom.

Each task row shows name, textual status, and recency. Project and task state remain isolated exactly as in the current implementation.

### 4.3 Task surface

Order:

1. **Task header**: headline, project, branch, task ID, run status, pause/stop, view change, overflow.
2. **Outcome Contract summary**: goal as the main heading, short scope/invariant summary, and compact metadata for write scope, mode, budget, and condition count.
3. **Stage line**: plan, execute, verify, prove. The active stage is textually labelled.
4. **Key execution stream**: important state changes, checkpoints, changed files, verification, and recovery events.
5. **Sticky composer**: instruction input plus workspace, write scope, mode, and cost context.

Completion conditions no longer form a separate large centre section. Their aggregate state appears in the Contract summary, while their individual evidence status remains in the result inspector.

### 4.4 Result inspector

Pending human decisions are pinned above all inspector views.

The inspector uses four views:

| View | Content |
|---|---|
| Proof | Deliverability verdict, completion conditions, evidence level, snapshot applicability |
| Evidence | Producer, status, condition links, summary, timestamp |
| Branches | Current branch, parent checkpoint, checkpoints, comparison entry points |
| Risks | Out-of-scope writes, invalidated proof, unknowns, degradation, autonomy state |

Proof is the default view. Switching views changes presentation only; it never mutates authoritative task state.

### 4.5 Composer

The composer replaces the page-wide bottom toolbar.

- With no selected task, submission starts a new task.
- With a working task, submission opens the existing contract-revision flow before any goal or scope change is accepted.
- Workspace, write paths, run mode, and cost are compact controls or status items in the composer tool row.
- Pause, stop, diff, and proof export remain task-header or inspector actions, not text-entry controls.
- The composer remains keyboard accessible and does not cover the last stream event.

## 5. Responsive Behaviour

### 5.1 Medium width: 760-1179 px

- The task rail remains visible at a reduced width.
- The result inspector becomes a right-side drawer.
- The task header exposes a labelled Proof action and pending-decision count.
- Opening the inspector traps focus and can be dismissed with Escape.

### 5.2 Narrow width: below 760 px

- The task rail becomes a side sheet opened from the task header.
- The task surface becomes the only default column.
- Proof opens as a full-height view with tabs for Evidence, Branches, and Risks.
- The composer remains sticky above the safe viewport edge.
- Secondary metadata wraps below the goal; no horizontal scrolling is required.

## 6. States

The layout must explicitly support:

- No projects or tasks.
- No task selected.
- Contract compiling or unavailable.
- Running, paused, waiting, stopped, failed, proven, and unrecoverable tasks.
- Pending human decision.
- Proof unavailable, incomplete, invalidated, or proven.
- Loading, request failure, and unauthorised/no-token states.
- Empty Evidence, branches, checkpoints, cognition, or experience.
- Light theme, dark theme, and reduced motion.

## 7. Implementation Boundaries

The workbench remains a single dependency-free HTML file served by the Runtime.

- Existing element IDs used by the JavaScript stay stable unless the same change updates every reference.
- Existing render and event functions remain the behavioural source of truth.
- Layout-specific state such as the active inspector view or open drawer stays presentation-only.
- User-visible strings continue through the server-injected i18n catalog.
- Protocol field names, event types, hashes, and proof payloads remain language-neutral machine data.
- Inline icons remain local SVG paths; no external asset request is introduced.
- The token remains in the URL fragment and is never copied into visible UI, logs, or requests.

## 8. Accessibility

- All icon-only controls have translated accessible names and tooltips.
- Sidebar, inspector tabs, dialogs, drawers, and composer have visible keyboard focus.
- Inspector tabs use tab semantics; drawers and dialogs restore focus when closed.
- Status never relies on colour alone.
- Mobile and desktop layouts preserve a logical reading and tab order.
- Motion remains subtle and respects `prefers-reduced-motion`.
- Text and controls meet WCAG AA contrast in both themes.

## 9. Verification

Implementation follows test-first development.

1. Add a failing workbench markup test that asserts the new shell regions, inspector tabs, sticky composer, and preserved functional IDs.
2. Add a failing localisation test for any new visible strings.
3. Implement the smallest markup and style changes that satisfy the tests.
4. Run Runtime and i18n tests, then full type checking and tests.
5. Start `keystone serve` and verify the real workbench in Chromium at:
   - 1440 x 900 wide desktop
   - 1024 x 768 medium width
   - 390 x 844 narrow width
6. Exercise task selection, task creation, pause/stop, contract revision, diff, proof export, inspector switching, theme switching, and pending decisions.
7. Check console errors, overflow, focus order, light/dark contrast, and reduced-motion behaviour.

## 10. Completion Criteria

- The approved Layout B hierarchy is recognisable at all three target widths.
- All current workbench actions remain reachable and behave as before.
- Proof verdict and pending decisions are visible without inspecting raw events.
- The main task stream and composer are the dominant centre experience.
- No Runtime API, Schema, kernel invariant, or protocol output changes.
- Runtime, i18n, typecheck, and full test suites pass.
- Browser verification shows no clipped controls, incoherent overlap, horizontal page overflow, console errors, or untranslated new UI text.

## 11. Rejected Alternatives

- **Focus-only task stream**: closest to DeepSeek Chat, but hides Keystone's core proof distinction behind an extra action.
- **Bottom proof dock**: uses width efficiently, but compresses completion conditions and evidence into a shallow strip that is harder to scan.
- **Keep the existing three independent scrolling columns**: preserves implementation shape but continues the dashboard-like hierarchy and page-wide form that motivated the redesign.
