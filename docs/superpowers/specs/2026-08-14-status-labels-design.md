# Concise Pull Request Status Labels

Issue: [#98](https://github.com/hcrosse/opencode-pr-tracker/issues/98)

## Decision

Shorten each pull request status to one or two words. Represent a brief refresh
failure as a separate soft-failure marker, then surface the diagnostic if the
failure lasts five minutes.

## Appearance Model

`statusAppearance` will continue to own status precedence, color tone, label,
and strikethrough behavior. Its result will add a `stale` boolean so callers do
not need to inspect the underlying status union.

Use this visible vocabulary:

| State | Label |
| --- | --- |
| Checks passed | `passed` |
| Checks pending | `pending` |
| Checks failed | `failed` |
| No checks | `no checks` |
| Merge conflict | `conflict` |
| Branch behind | `behind` |
| Merged | `merged` |
| Closed | `closed` |
| Status unavailable without a diagnostic | `unavailable` |

Unavailable diagnostics remain actionable but concise:

| Diagnostic | Label |
| --- | --- |
| GitHub CLI missing | `install gh` |
| GitHub authentication required | `authenticate` |
| GitHub unavailable | `GitHub unavailable` |
| Pull request missing or inaccessible | `inaccessible` |
| Invalid GitHub response | `invalid response` |

Status precedence, tones, and strikethrough behavior will not change.

## TUI Rendering

The TUI will render the pull request reference and status using the existing
status tone. For the first five minutes of consecutive refresh failures, it
will retain the last known status and render a separate `stale` marker in muted
italic text after it. The marker will not include the refresh diagnostic while
the failure remains soft.

Polling will record when consecutive refresh failures begin. If another
refresh fails at least five minutes later, polling will replace the cached
status with an unavailable status carrying the latest diagnostic. The existing
unavailable appearance will then show the concise diagnostic label. A
successful refresh or detachment will clear the recorded failure time. Manual
refreshes will use elapsed time and therefore cannot accelerate escalation.

Cached statuses and failure times will remain local to the active polling
instance. Reopening a session or restarting OpenCode will start without cached
status; an initial refresh failure will therefore show its unavailable
diagnostic immediately. If polling is delayed while a session remains open,
the current row will stay stale until the next refresh resolves it or escalates
it based on elapsed time. No separate escalation timer or persisted stale state
will be added.

Example: a pull request whose last known result was pending will render as
`#123 pending · stale`, with `pending` yellow and `stale` muted and italic.

## Verification

Focused appearance tests will exhaustively cover the concise base labels,
unavailable diagnostics, and stale metadata. Polling tests with a controlled
clock will verify soft failure, five-minute escalation, recovery, and cleanup.
A TUI behavior test will verify that stale data produces a separate marker
while retaining the base status. The repository's full `bun run check` command
will verify formatting, linting, tests, build output, package contents, and
whitespace.

Manual verification will load the issue worktree plugin in OpenCode and confirm
that normal and stale pull request rows remain readable in the sidebar.

## Scope

This change will not alter the polling interval, error classification, status
precedence, compact-layout configuration, or attachment state.
