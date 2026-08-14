# Pull Request Reordering Spike

## Decision

Proceed with persisted, user-controlled pull request ordering.

The first implementation should provide a keyboard-driven reorder dialog and a structured agent tool backed by one atomic state operation. It should not include drag and drop. Drag and drop is feasible with the pinned OpenTUI APIs, but it should remain an optional follow-up because it adds terminal-specific mouse behavior without replacing the required keyboard path.

Standalone pull requests are individual move units. The attached subset of a GitHub Stack is one move unit that always retains GitHub's bottom-to-top review order. Manual ordering positions that complete unit among other standalone pull requests and Stacks.

## Current Behavior

The persisted `pullRequests` array already defines display order. `StateStore.list` returns that array unchanged, polling projects statuses onto it without sorting, and the sidebar renders the projected items in sequence. A reorder operation can therefore move existing array entries without changing the version 1 state shape.

State mutations use a per-session file lock, reread the current file after acquiring the lock, write a temporary file, and atomically rename it. The same boundary can serialize moves with attach, detach, and cleanup operations.

GitHub Stack attachment already removes discovered members and reinserts the complete group in GitHub position order at the earliest existing member. Stack membership is not persisted, so reorder clients need a remote-authoritative membership projection before presenting or moving units.

Relevant code:

- [`src/state.ts`](../src/state.ts) defines the persisted array, lock, and atomic write.
- [`src/polling.ts`](../src/polling.ts) preserves state order when publishing sidebar items.
- [`src/pull-request-tui.tsx`](../src/pull-request-tui.tsx) renders items in publication order and establishes the existing dialog command pattern.
- [`src/github-stack.ts`](../src/github-stack.ts) validates and sorts remote Stack positions.

## Interaction Comparison

| Model                                         | TUI feasibility                                             | Keyboard-only use        | Mouse support                    | Discoverability                                               | Accessibility                                                               | Complexity                           | Automatic-order interaction                                                              |
| --------------------------------------------- | ----------------------------------------------------------- | ------------------------ | -------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Custom reorder dialog                         | Supported by public dialog, renderer, and keymap APIs       | Complete                 | Optional dialog selection        | High through command palette and slash command                | Strongest option because every action has a keyboard path and visible state | Medium                               | Commits an explicit manual move after automatic attachment                               |
| Sidebar drag and drop                         | Low-level events exist; no high-level draggable abstraction | Requires a separate path | Direct but terminal-dependent    | High for mouse users, weak for keyboard users                 | Insufficient alone; a non-drag alternative remains required                 | High                                 | Must call the same state move operation to avoid divergent semantics                     |
| Structured agent tool                         | Supported by the existing server tool model                 | Not applicable           | Not applicable                   | High for agents when tool description is explicit             | Avoids simulated input                                                      | Low after the state operation exists | Expresses manual intent directly and atomically                                          |
| Explicit top, bottom, before, and after moves | Supported in both dialog and tool                           | Complete                 | Can be exposed through either UI | High when destination is named                                | Clear and non-gestural                                                      | Low                                  | Identity-relative destinations remain meaningful when unrelated attachments change       |
| Numeric position                              | Supported but not recommended                               | Complete                 | Not applicable                   | Familiar but ambiguous about one-based or zero-based indexing | Neutral                                                                     | Low                                  | Snapshot-relative positions can change meaning after concurrent attachment or detachment |
| Whole-list replacement                        | Technically possible but rejected                           | Complete                 | Not applicable                   | Low                                                           | Neutral                                                                     | Medium                               | Maximizes conflict scope and risks omission, duplication, or accidental detachment       |

## OpenTUI API Evidence

The pinned OpenTUI 0.4.5 release exposes `onMouseDrag`, `onMouseDragEnd`, and `onMouseDrop` through `RenderableOptions`. `MouseEvent` includes terminal-cell coordinates, the event target, and the captured drag source. The renderer internally captures a renderable when a left-button drag begins and routes release and drop events, but it does not expose a public pointer-capture API or a draggable component abstraction.

OpenCode 1.18.15 exposes dialog replacement, `DialogSelect`, renderer access, lifecycle cleanup, and keymap layers through `TuiPluginApi`. `DialogSelect` already handles keyboard navigation, but its arrows move the highlighted option rather than reorder data. A reorder interaction therefore needs either a custom dialog with a scoped keymap layer or a select-then-move flow.

This evidence is sufficient to establish feasibility without a throwaway production-code prototype:

- [OpenTUI 0.4.5 `RenderableOptions`](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/Renderable.ts)
- [OpenTUI 0.4.5 mouse event parsing](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/lib/parse.mouse.ts)
- [OpenTUI 0.4.5 renderer drag capture and drop dispatch](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/renderer.ts)
- [OpenCode 1.18.15 `TuiPluginApi`](https://github.com/anomalyco/opencode/blob/325529761beb79a004de6d86e48b8db69cf4eba3/packages/plugin/src/tui.ts)
- [OpenCode 1.18.15 `DialogSelect`](https://github.com/anomalyco/opencode/blob/325529761beb79a004de6d86e48b8db69cf4eba3/packages/tui/src/ui/dialog-select.tsx)
- [WCAG 2.2 keyboard guidance](https://www.w3.org/TR/WCAG22/#keyboard)
- [WCAG 2.2 dragging guidance](https://www.w3.org/TR/WCAG22/#dragging-movements)

## Human Interaction

Add a `Reorder pull requests` palette command with slash name `/pr-reorder`.

1. Resolve current Stack membership and open a medium dialog containing the ordered standalone and Stack move units.
2. Move the highlight with the existing selection keys.
3. Press Enter to enter move mode for the highlighted unit.
4. Use Up and Down to preview adjacent moves. Use Shift+Up and Shift+Down to move directly to top and bottom; Home and End may provide equivalent bindings.
5. Press Enter to commit one move, or Escape to cancel without writing.
6. Keep the moved unit highlighted and show a success or conflict toast.

The dialog should display a clear move-mode instruction and a non-color marker on the selected row. The initial implementation should not add hidden modifier-only shortcuts or require mouse support.

## Agent Tool Contract

Add a `pr_move` tool that identifies pull requests by canonical GitHub URL. Number-only identity is unsafe because one session may contain the same pull request number from multiple repositories. Naming any attached Stack member selects the attached subset of that Stack as one move unit. An anchor that names a member of another Stack targets that complete unit.

```ts
type MoveDestination =
  | Readonly<{ placement: "top" }>
  | Readonly<{ placement: "bottom" }>
  | Readonly<{ placement: "before"; anchor: PullRequestUrl }>
  | Readonly<{ placement: "after"; anchor: PullRequestUrl }>

type ResolvedMoveDestination =
  | Readonly<{ placement: "top" }>
  | Readonly<{ placement: "bottom" }>
  | Readonly<{ placement: "before"; anchor: NonEmptyPullRequests }>
  | Readonly<{ placement: "after"; anchor: NonEmptyPullRequests }>

type MoveOutcome = Readonly<{
  status: "moved" | "unchanged"
  pullRequests: NonEmptyPullRequests
  previous?: NonEmptyPullRequests
  next?: NonEmptyPullRequests
}>

move(
  sessionID: string,
  expectedRevision: string,
  pullRequests: NonEmptyPullRequests,
  destination: ResolvedMoveDestination,
): Promise<Result<MoveOutcome, StateFailure | MoveFailure>>
```

The public tool schema should model the destination as a tagged union rather than accepting an optional anchor whose validity depends on another field. Before calling the state operation, the server resolves the selected and anchor URLs into current move units and derives an order revision from the complete ordered URL list. The result should name every moved pull request and the unit's final neighbors so an agent can report the actual outcome.

Do not expose whole-list replacement. Numeric positions may be presented inside the human dialog, but they should not be the persisted or agent-facing operation.

## Ordering and Persistence Semantics

- The array order is the sole persisted order; no schema migration or per-item position field is needed.
- A move changes only array position. It preserves canonical URL, `attachedAt`, status cache identity, and attachment count.
- A standalone pull request is one move unit. Every currently attached member of the same remotely resolved GitHub Stack forms one ordered move unit, including partial Stacks with internal gaps or unattached outer members.
- `top` and `bottom` target the complete session list across repositories.
- `before` and `after` use a canonical URL anchor from the same session and resolve it to its complete move unit. Repositories do not form implicit groups.
- Moving relative to the same move unit is invalid and does not write.
- Moving to the existing destination returns `unchanged` and does not write.
- A missing subject, missing anchor, or changed attachment order returns a specific conflict and does not write.
- Polling and sidebar refresh continue to consume the stored order without additional sorting.

## Concurrent Updates

Every move must acquire the existing per-session lock and reread state before validation. This makes each move linearizable with attach, detach, cleanup, and other moves according to lock acquisition order.

The membership resolver computes a revision from the complete ordered URL list. The locked operation compares that revision with the current state before moving. If the current ordered URL list differs from the resolved list, the move fails without mutation and the caller refreshes membership before retrying. Concurrent moves serialize; only a move based on the current list succeeds.

The derived revision intentionally detects current-state differences, not every intervening mutation. A detach and reattach or multiple moves may restore the same list, but the identity-relative operation remains valid against that restored state. Detecting such ABA changes would require a persisted monotonic generation, which is unnecessary for this move contract. A future bulk-order operation would still require exact membership validation and is outside the recommendation.

## GitHub Stack Semantics

GitHub Stack order and contiguity are invariants for attached Stack members.

- Initial Stack discovery attaches new members in GitHub bottom-to-top order.
- Reordering any member moves every attached member of that Stack as one contiguous unit in GitHub order.
- Attaching any member of a fully attached Stack is idempotent. Attaching a missing member reconstructs the attached subset as one ordered unit at its existing earliest position.
- Detaching remains scoped to the selected pull request. The remaining attached subset stays one move unit and retains the gaps implied by remote Stack positions.
- One bounded membership resolver operation should project all attached URLs into standalone or Stack units before opening the reorder dialog. It may issue validated continuation requests to exhaust paginated Stack entries. If membership cannot be resolved safely, the dialog and tool fail without mutation rather than splitting a possible Stack.
- No Stack identifier or manual-order flag needs to be persisted for reordering.

Visual Stack linkage is useful but independent of ordering semantics. [#111](https://github.com/hcrosse/opencode-pr-tracker/issues/111) defines light box-drawing markers for complete Stacks, incomplete outer boundaries, and internal unattached ranges. It can reuse the same bounded membership projection.

The selected concise treatment uses `┌─` and `└─` only for complete visible boundaries. `├─` means the Stack continues beyond a visible boundary, `├┄` labels an internal unattached range, and trailing `┊` means the Stack continues after the final visible attached row:

```text
├─ owner/repo#12 passed
│  Base migration
├┄ 1 PR not attached
├─ owner/repo#14 pending
│  API update
├─ owner/repo#15 draft
┊  Client wiring
```

Compact layout omits title connector rows. It retains boundary and gap markers, with the final `├─` alone indicating that the Stack continues beyond the last attached member:

```text
├─ owner/repo#12 passed
├┄ 1 PR not attached
├─ owner/repo#14 pending
├─ owner/repo#15 draft
```

## Follow-Up Work

### Persisted reorder operation and agent tool

[#117](https://github.com/hcrosse/opencode-pr-tracker/issues/117) tracks batched Stack membership projection, revision derivation, `StateStore.move`, the `pr_move` server tool, and focused state, concurrency, mixed-repository, partial-Stack, and server-schema tests.

### Keyboard reorder dialog

[#116](https://github.com/hcrosse/opencode-pr-tracker/issues/116) tracks `/pr-reorder` with Stack-as-unit presentation, scoped move-mode bindings, adjacent Up/Down movement, Shift+Up/Shift+Down boundary movement, preview state, commit and cancel behavior, refresh publication, toasts, and rendered interaction tests.

### Optional drag and drop

[#110](https://github.com/hcrosse/opencode-pr-tracker/issues/110) tracks a mouse enhancement that delegates to the same move operation. It is deferred in the project backlog until the canonical keyboard flow exists and representative terminal behavior can be tested.

### GitHub Stack visualization

[#111](https://github.com/hcrosse/opencode-pr-tracker/issues/111) tracks the selected concise box-drawing markers for Stack relationships. Deferred alternatives preserve the design exploration for [inline annotations (#113)](https://github.com/hcrosse/opencode-pr-tracker/issues/113), [explicit outer placeholder rows (#114)](https://github.com/hcrosse/opencode-pr-tracker/issues/114), and [collapsed Stack summaries (#115)](https://github.com/hcrosse/opencode-pr-tracker/issues/115).

### Stack-scoped attachment and detachment

[#118](https://github.com/hcrosse/opencode-pr-tracker/issues/118) tracks atomic one, all, open/non-open, selected-and-above, and selected-and-below scopes for state and agent tools. [#119](https://github.com/hcrosse/opencode-pr-tracker/issues/119) adds the dependent TUI scope selector while keeping standalone flows unchanged.

## Risks and Verification

- OpenTUI drag support is source-verified but not exercised across terminal emulators or multiplexers. This is why drag is deferred.
- A custom dialog must unregister its keymap layer during every close, cancellation, and plugin-abort path.
- Stack membership can change remotely after resolution. One move uses one validated membership snapshot; the next dialog or tool call refreshes it. Reattachment must preserve the Stack unit's position among other units while rebuilding its attached subset in GitHub order.
- A move may succeed before an unlock or lock-compromise error is reported by the current persistence boundary. Idempotent destination semantics make retries safe, but callers must surface the storage failure.
- Full implementation should cover concurrent attach, detach, move, and session cleanup across separate store instances.
