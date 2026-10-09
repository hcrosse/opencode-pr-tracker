# Stack-Aware Pull Request Move Design

## Decision

Add one bounded Stack-membership resolver, one atomic `StateStore.move` operation,
and one structured `pr_move` server tool. Keep the version 1 state file unchanged.
Do not add TUI interaction, drag and drop, numeric destinations, whole-list
replacement, or Effect adoption in this change.

This design implements the state and server portion of the reordering decision
recorded by issue #83 and its draft in pull request #120.

## Current Behavior

The persisted `pullRequests` array defines attachment and sidebar order.
`StateStore` protects each session file with `proper-lockfile`, rereads state under
the lock, writes a temporary version 1 file, and atomically renames it. Attach,
detach, and cleanup already share that boundary.

`GitHubClient.getStacks` accepts at most 20 pull requests, resolves the initial
memberships in one GraphQL request, exhausts validated Stack continuation pages,
and preserves caller cancellation. It returns one membership result for each
requested pull request.

## Move Units

A standalone pull request is one move unit. Every attached member of one remotely
resolved GitHub Stack is one move unit in GitHub bottom-to-top position order.
Unattached Stack members are not added to state.

Add a focused domain module with these concepts:

```ts
type PullRequestMoveUnit = Readonly<{
  pullRequests: NonEmptyPullRequests
}>

type PullRequestOrderRevision = string // branded, created only by the revision function

type PullRequestMoveSnapshot = Readonly<{
  revision: PullRequestOrderRevision
  units: readonly PullRequestMoveUnit[]
}>
```

The revision is a SHA-256 digest of the JSON serialization of the complete,
ordered canonical URL list. It represents current order, not mutation history.
An ABA sequence that restores the same URL list therefore restores the same
revision by design.

The resolver accepts the current attachments and calls `GitHubClient.getStacks`
once. It fails without mutation when the batch fails, any item fails, the result
count differs from the request count, a requested pull request is absent from its
reported membership, aliases disagree about one Stack, an attached pull request
appears in conflicting units, or the resolved attached Stack subset is not
already contiguous and in GitHub order. These checks prevent a move from
splitting or silently normalizing uncertain membership.

The resolver scans the current attachment order to produce ordered units. It
filters each valid remote Stack to attached members, includes each attachment
exactly once, and derives the revision from the original ordered URL list.

## State Operation

Extend `StateStore` with tagged destinations and an atomic move:

```ts
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
  expectedRevision: PullRequestOrderRevision,
  pullRequests: NonEmptyPullRequests,
  destination: ResolvedMoveDestination,
): Promise<Result<MoveOutcome, StateFailure | MoveFailure>>
```

`move` acquires the existing per-session lock, rereads the state file, and
compares the current ordered URL revision before interpreting the move. A
difference returns `PullRequestOrderChanged` without writing. The operation then
requires every subject member, and every relative anchor member, to form the
exact contiguous subsequence supplied by the resolver.

Expected move failures distinguish a stale order, a missing or invalid subject
unit, a missing or invalid anchor unit, and a same-unit relative anchor. The
tagged destination type makes missing anchors and unsupported placements invalid
before the state transition. The OpenCode schema rejects malformed external
destinations at the server boundary.

For a valid move, the operation removes the complete subject subsequence and
inserts it at the requested unit boundary. `top` and `bottom` span repositories.
`before` and `after` target the complete anchor subsequence. Moving to the current
destination returns `unchanged` without replacing the state file. A successful
write preserves each original `PullRequestAttachment`, including canonical URL
and `attachedAt`, and returns the moved unit plus its final neighboring units.

The existing lock makes moves linearizable with attach, detach, cleanup, and
other moves. A concurrent mutation that changes URL order before the move gets
the lock causes the move revision check to fail. A mutation that gets the lock
after the move observes the moved state. No persisted generation is added.

## Server Tool

Add `pr_move` with this input shape:

```ts
type PrMoveInput = Readonly<{
  pull_request: string
  destination:
    | Readonly<{ placement: "top" }>
    | Readonly<{ placement: "bottom" }>
    | Readonly<{ placement: "before"; anchor: string }>
    | Readonly<{ placement: "after"; anchor: string }>
}>
```

The subject and anchor must be canonical
`https://github.com/<owner>/<repository>/pull/<number>` URLs. Number-only and
scheme-less identity are rejected for this tool because the operation is meant
to be explicit across mixed repositories.

Execution reads the invoking session attachments, resolves one complete move
snapshot with the caller's abort signal, finds the subject and optional anchor
units, and calls `StateStore.move`. Naming any attached Stack member selects its
complete attached Stack subset. A relative anchor in the same unit fails without
mutation.

The tool translates typed resolver and state failures into `PrToolError`. Its
success text lists every moved URL and the final previous and next units, with an
explicit absent boundary. This gives agents the actual committed placement
without requiring a second state read.

## Testing

Follow test-driven development through public interfaces:

- Resolver tests cover standalone, complete and partial Stacks, mixed
  repositories, one bounded batch, pagination and cancellation propagation,
  per-item failures, inconsistent aliases, missing membership, and noncontiguous
  or misordered attached subsets.
- State tests cover all destinations, unchanged moves, preserved timestamps and
  version 1 serialization, every no-write failure, ABA revision semantics, and
  concurrent attach, detach, move, cleanup, and move operations across separate
  stores using real temporary files and the production lock.
- Server tests cover the discriminated tool schema, canonical URL enforcement,
  Stack-member selection, relative anchors, caller cancellation, structured
  errors, output neighbors, and mixed repositories.
- Repository verification is `bun run check`.

## Effect Follow-Up

Effect may be useful for typed errors, schemas, dependency composition,
cancellation, and test services, but adoption is a cross-cutting architecture
decision. Evaluate it separately against a representative vertical slice,
including Bun and OpenCode compatibility, package and build impact, migration
boundaries, v3 versus v4 timing, contributor workflow, and rollback cost.
