# Concise Pull Request Status Labels

Issue: [#98](https://github.com/hcrosse/opencode-pr-tracker/issues/98)

## Decision

Shorten each pull request status to one or two words. Represent stale data as a
separate soft-failure marker instead of combining refresh diagnostics with the
last known status.

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
status tone. When `stale` is true, it will render a separate `stale` marker in
muted italic text after the status. The marker will not include the refresh
failure diagnostic because staleness is a soft failure and the row should stay
compact.

Example: a pull request whose last known result was pending will render as
`#123 pending · stale`, with `pending` yellow and `stale` muted and italic.

## Verification

Focused appearance tests will exhaustively cover the concise base labels,
unavailable diagnostics, and stale metadata. A TUI behavior test will verify
that stale data produces a separate marker while retaining the base status.
The repository's full `bun run check` command will verify formatting, linting,
tests, build output, package contents, and whitespace.

Manual verification will load the issue worktree plugin in OpenCode and confirm
that normal and stale pull request rows remain readable in the sidebar.

## Scope

This change will not alter GitHub polling, error classification, cached status
behavior, status precedence, compact-layout configuration, or attachment state.
