# Pull Request Reordering Spike

## Decision

Proceed with persisted, user-controlled pull request ordering.

The first implementation should provide a keyboard-driven reorder dialog and a structured agent tool backed by one atomic state operation. It should not include drag and drop. Drag and drop is feasible with the pinned OpenTUI APIs, but it should remain an optional follow-up because it adds terminal-specific mouse behavior without replacing the required keyboard path.

Manual order is authoritative after attachment. GitHub Stack order supplies an initial default when members are discovered, but later attachment must not silently undo manual moves.

## Current Behavior

The persisted `pullRequests` array already defines display order. `StateStore.list` returns that array unchanged, polling projects statuses onto it without sorting, and the sidebar renders the projected items in sequence. A reorder operation can therefore move existing array entries without changing the version 1 state shape.

State mutations use a per-session file lock, reread the current file after acquiring the lock, write a temporary file, and atomically rename it. The same boundary can serialize moves with attach, detach, and cleanup operations.

GitHub Stack attachment currently removes discovered members and reinserts the complete group in GitHub position order at the earliest existing member. This correctly establishes the initial bottom-to-top order, but repeating it after a manual move would overwrite the user's choice.

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

1. Open a medium dialog containing the current attachment order.
2. Move the highlight with the existing selection keys.
3. Press Enter to enter move mode for the highlighted pull request.
4. Use Up and Down to preview adjacent moves, or Home and End to preview top and bottom.
5. Press Enter to commit one move, or Escape to cancel without writing.
6. Keep the moved pull request highlighted and show a success or conflict toast.

The dialog should display a clear move-mode instruction and a non-color marker on the selected row. The initial implementation should not add hidden modifier-only shortcuts or require mouse support.

## Agent Tool Contract

Add a `pr_move` tool that identifies pull requests by canonical GitHub URL. Number-only identity is unsafe because one session may contain the same pull request number from multiple repositories.

```ts
type MoveDestination =
  | Readonly<{ placement: "top" }>
  | Readonly<{ placement: "bottom" }>
  | Readonly<{ placement: "before"; anchor: PullRequestUrl }>
  | Readonly<{ placement: "after"; anchor: PullRequestUrl }>

type MoveOutcome = Readonly<{
  status: "moved" | "unchanged"
  pullRequest: PullRequestUrl
  previous?: PullRequestUrl
  next?: PullRequestUrl
}>

move(
  sessionID: string,
  pullRequest: PullRequestUrl,
  destination: MoveDestination,
): Promise<Result<MoveOutcome, StateFailure | MoveFailure>>
```

The tool schema should model the destination as a tagged union rather than accepting an optional anchor whose validity depends on another field. The result should name the moved pull request and its final neighbors so an agent can report the actual outcome.

Do not expose whole-list replacement. Numeric positions may be presented inside the human dialog, but they should not be the persisted or agent-facing operation.

## Ordering and Persistence Semantics

- The array order is the sole persisted order; no schema migration or per-item position field is needed.
- A move changes only array position. It preserves canonical URL, `attachedAt`, status cache identity, and attachment count.
- `top` and `bottom` target the complete session list across repositories.
- `before` and `after` use a canonical URL anchor from the same session. Repositories do not form implicit groups.
- Moving relative to the same pull request is invalid and does not write.
- Moving to the existing destination returns `unchanged` and does not write.
- A missing subject or anchor returns a specific conflict and does not write.
- Polling and sidebar refresh continue to consume the stored order without additional sorting.

## Concurrent Updates

Every move must acquire the existing per-session lock and reread state before validation. This makes each move linearizable with attach, detach, cleanup, and other moves according to lock acquisition order.

Identity-relative destinations remain stable when an unrelated pull request is attached or detached. If the subject or anchor disappears before the move acquires the lock, the move fails without mutation and the caller refreshes before retrying. Concurrent moves of the same subject serialize; the later successful move becomes the visible order.

The initial implementation does not need a persisted revision. A revision would add state-format and migration cost while the proposed operation already rejects missing identities and does not replace the complete list. A future bulk-order operation would require an expected revision and exact membership validation.

## GitHub Stack Semantics

GitHub Stack order is an automatic default, not a permanent invariant.

- Initial Stack discovery attaches new members in GitHub bottom-to-top order.
- Manual moves may separate or reverse individual Stack members.
- Attaching any member of a fully attached Stack is idempotent and must not normalize existing order.
- Discovering missing members preserves the relative and absolute order of every existing attachment. Process missing members in GitHub bottom-to-top order: insert after the nearest attached predecessor in that Stack, otherwise before the nearest attached successor, otherwise append the complete new Stack. This may leave manually separated Stack members noncontiguous, which is preferable to undoing manual order.
- Detaching remains scoped to the selected pull request.
- No Stack identifier or manual-order flag needs to be persisted for reordering.

Visual Stack linkage is useful but independent of ordering semantics. It requires trustworthy Stack membership at render time and is tracked separately in [#111](https://github.com/hcrosse/opencode-pr-tracker/issues/111).

## Follow-Up Work

### Persisted reorder operation and agent tool

Implement `StateStore.move`, the `pr_move` server tool, Stack reattachment precedence, and focused state, concurrency, mixed-repository, and server-schema tests.

### Keyboard reorder dialog

Implement `/pr-reorder` with scoped move-mode bindings, preview state, commit and cancel behavior, refresh publication, toasts, and rendered interaction tests.

### Optional drag and drop

[#110](https://github.com/hcrosse/opencode-pr-tracker/issues/110) tracks a mouse enhancement that delegates to the same move operation. It is deferred in the project backlog until the canonical keyboard flow exists and representative terminal behavior can be tested.

### GitHub Stack visualization

[#111](https://github.com/hcrosse/opencode-pr-tracker/issues/111) tracks box-drawing markers for Stack relationships. It is ready as a separate user-visible enhancement because it can be designed independently of manual reordering.

## Risks and Verification

- OpenTUI drag support is source-verified but not exercised across terminal emulators or multiplexers. This is why drag is deferred.
- A custom dialog must unregister its keymap layer during every close, cancellation, and plugin-abort path.
- Stack membership can change remotely. Reattachment behavior must preserve existing manual order while adding only newly discovered members.
- A move may succeed before an unlock or lock-compromise error is reported by the current persistence boundary. Idempotent destination semantics make retries safe, but callers must surface the storage failure.
- Full implementation should cover concurrent attach, detach, move, and session cleanup across separate store instances.
