# GitHub Stack Sidebar Markers Design

Issue: [#111](https://github.com/hcrosse/opencode-pr-tracker/issues/111)

## Decision

Show attached GitHub Stack members as one visual unit using light box-drawing markers. Standalone pull requests and attachments without valid current or previously resolved Stack metadata keep the existing bullet.

Stack discovery remains separate from status polling. Each refresh starts one bounded Stack batch for all attached pull requests, alongside the existing status batch. The GitHub adapter deduplicates continuation requests by Stack ID and exhausts each distinct Stack once. The 20-attachment session limit bounds the initial batch, not the size of a remote Stack; discovery must exhaust Stacks larger than 20 members.

## GitHub Boundary

Extend the GitHub client with a batch Stack operation aligned to the requested pull requests. Each successful item is either a standalone pull request or a Stack identity with its complete bottom-to-top member list. The adapter validates canonical URLs, repository identity, Stack identity, size, positions, pagination, duplicate positions, duplicate URLs, and requested-member inclusion before returning domain values.

The initial GraphQL request resolves all attached pull requests together. Responses that identify the same Stack share one validated result. If a Stack requires continuation pages, the adapter follows those pages once for that Stack rather than once per attached member. Caller cancellation propagates through the initial and continuation requests.

The existing single-pull-request Stack operation used by attachment delegates to the same resolver for one input. This preserves atomic Stack attachment behavior without maintaining two parsing paths.

The persisted session limit remains 20 attachments. Attaching any Stack resolves its complete membership before acquiring the write lock and re-checking capacity. A Stack larger than 20, or a Stack whose missing members would take the current session above 20, fails atomically without adding, removing, or reordering any member. This includes a session with 19 attachments attempting to attach a two-member Stack.

## Polling

The session poller retains the latest successful Stack membership for each canonical pull request URL. Every refresh requests current membership for all attachments, including merged pull requests, because Stack presentation is independent of status refresh eligibility.

Status and Stack requests run concurrently. Successful membership replaces prior membership, including a successful transition from Stack member to standalone. A failed membership item keeps its last successful value. If no successful value exists, the item has unknown membership and renders as a standalone bullet. Removed attachments are removed from both status and membership caches.

The poller publishes available status and membership data even when one GitHub operation partially fails. A forced refresh still reports the GitHub failure so `/pr-sync` does not claim full success.

## Projection

Rendering derives Stack units from attachment order and resolved membership without changing persisted state. A Stack unit is valid only when all attached members for that Stack form one contiguous run and their positions increase in GitHub bottom-to-top order. If membership is incomplete, contradictory, split by another attachment, or ordered differently, every affected attachment uses the ordinary bullet. This avoids implying a false relationship after remote Stack changes or in mixed-repository sessions.

For a valid unit, compare attached member positions with the complete Stack list:

- Use `┌─` when the first attached member is the Stack base; otherwise use `├─`.
- Use `└─` when the last attached member is the Stack head; otherwise use `├─`.
- Use `├─` for intermediate attached members.
- Insert `├┄ N PR not attached` or `├┄ N PRs not attached` for each internal position gap.
- Do not add rows for unattached members below the first or above the last attached member.

Stack identity, not repository or branch naming, determines grouping. Different Stacks in the same repository remain separate, and Stack members from different repositories are rejected by the GitHub parser.

## Rendering

Each attached pull request remains the only interactive row in its unit. Gap rows have no mouse handler. Status color, stale marker, strikethrough, wrapping, collapsing, update notices, and click-to-open behavior remain unchanged.

Default layout renders the connector in the marker column and aligns the title beneath the pull request text. Intermediate title rows use `│`. The final title row uses `┊` when unattached higher Stack members exist; otherwise it uses a blank alignment prefix after `└─` closes the Stack.

Compact layout omits title rows. Its final `├─` indicates that the Stack continues above the last attached member without adding a continuation row.

## Verification

GitHub adapter tests will cover one bounded initial batch, deduplicated continuation requests, standalone results, complete multi-page Stacks larger than 20 members, per-item invalid data, cancellation, and mixed repositories. Attachment tests will cover an oversized Stack and a 19-plus-2 capacity failure without partial mutation.

Polling tests will cover concurrent status and Stack resolution, successful membership replacement, retention after transient failure, unknown initial membership, merged pull requests, removed attachments, and surfaced forced-refresh failures.

Rendered TUI tests will cover complete boundaries, incomplete lower and upper boundaries, singular and plural internal gaps, default and compact layouts, ordinary fallback for stale initial or contradictory metadata, mixed repositories, title alignment, non-interactive gap rows, and unchanged pull request click behavior.

The README will document Stack markers, gap labels, partial-boundary behavior, and fallback behavior when Stack metadata has never resolved.
