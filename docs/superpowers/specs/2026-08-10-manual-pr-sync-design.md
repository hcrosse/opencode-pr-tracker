# Manual Pull Request Sync Design

## Purpose

Add a model-free TUI command that immediately refreshes the GitHub status of
every pull request attached to the displayed OpenCode session. The existing
60-second polling interval remains unchanged.

## Interaction

The TUI plugin registers:

- Command-palette action `pr.sync`, titled `Sync pull request status`.
- Slash command `/pr-sync`.

The command operates on the currently displayed session and does not prompt for
a pull request. It reports one of these outcomes with a toast:

- `Open a session first` when invoked outside a session route.
- `No pull requests are attached` when the session has no attachments.
- The existing actionable storage error when attachments cannot be read.
- `Pull request status refreshed` after the refresh attempt finishes.

The command does not create a session message or invoke a model.

## Refresh Semantics

Manual sync uses the sidebar component's existing in-memory status store and
polling lifecycle. The refresh bus becomes asynchronous so the command can wait
for the mounted sidebar poller to finish.

A manual sync is forced: it queries every attachment, including pull requests
whose last known lifecycle is merged or closed. Timer-driven and session-event
refreshes keep their current behavior and skip terminal pull requests.

Only one poll runs at a time. If sync is invoked while a poll is active, the
poller queues one forced trailing refresh. Multiple requests during the same
active poll coalesce into that single trailing refresh.

If no sidebar poller is mounted for the session, the command reports `Open the
sidebar first` rather than claiming a refresh occurred. Opening the sidebar
still triggers its normal immediate poll.

GitHub failures retain the prior successful status and mark it stale, matching
scheduled polling. Completion means the refresh attempt finished; individual
unavailable statuses remain visible in the sidebar.

## Implementation Boundary

`SessionPolling.refresh` accepts a force option. The force flag flows only into
the decision that currently skips terminal pull requests. The polling module
continues to own request coalescing, cancellation, stale-state handling, and
status publication.

The refresh bus accepts asynchronous listeners and returns how many listeners
handled the request. TUI command registration owns route validation, attachment
preflight, user feedback, and dispatching the forced refresh.

No persisted state or server-plugin API changes are required.

## Verification

Automated tests cover:

- `pr.sync` and `/pr-sync` command registration.
- Rejection outside a session and with no attachments.
- Awaited successful refresh feedback.
- Forced refresh of a terminal pull request.
- One forced trailing refresh when requested during an active poll.
- No change to timer-driven terminal-state suppression or the 60-second cadence.
- Missing mounted-sidebar handling.

The production build and generated-distribution check remain part of the normal
repository verification.

## Non-Goals

- Changing the polling interval.
- Refreshing only one selected pull request.
- Adding a mouse target or keybinding.
- Changing attachment persistence or GitHub CLI invocation.
- Adding release automation, dependency maintenance, or public documentation
  cleanup; those belong to subsequent pull requests.
