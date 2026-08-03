# OpenCode PR Tracker Design

## Purpose

Build a small OpenCode plugin that associates GitHub pull requests with an
OpenCode session and shows their CI state in the TUI sidebar. Agents attach PRs
through a tool. Humans use a model-free slash command as a fallback.

The plugin is intended for Herdr workflows where several OpenCode processes run
in separate tabs or workspaces. Each process polls the PRs for its displayed
session. Closing that process stops its polling.

## Goals

- Let an agent attach and detach a GitHub PR from its current session.
- Let a user attach and detach a PR through TUI slash commands without invoking
  a model.
- Persist attachments across OpenCode restarts.
- Poll attached PRs while their session is displayed by an open TUI process.
- Show PR identity, title, lifecycle state, and CI state in the sidebar.
- Open a PR in the default browser when its sidebar row is clicked.
- Keep credentials, API access, and command execution delegated to an
  authenticated GitHub CLI installation.
- Minimize and pin the package's supply-chain surface.

## Non-Goals

- Discover or attach PRs by parsing session text.
- Poll sessions that are not displayed by an open OpenCode process.
- Run a daemon or continue polling after OpenCode exits.
- Fix failed checks, merge PRs, notify the desktop, or archive sessions.
- Read or store GitHub tokens.
- Support GitHub Enterprise Server in the first version.
- Publish the first version to npm.

## Architecture

The package exposes separate OpenCode server and TUI plugin entry points. Both
use shared TypeScript modules for URL validation and persistent state.

### Server Plugin

The server plugin registers two agent tools:

- `pr_attach`: validates and attaches one canonical GitHub PR URL to the tool
  invocation's `sessionID`.
- `pr_detach`: removes one attached PR URL from the current session.

Both operations are idempotent. Tool results state whether the attachment was
added, already present, removed, or absent.

### TUI Plugin

The TUI plugin registers:

- `/pr-attach`: opens a URL prompt and attaches the validated PR to the current
  session.
- `/pr-detach`: opens a selection dialog for the current session's attached
  PRs and removes the selected PR.
- A `sidebar_content` slot that renders attached PRs and their current state.

OpenCode's modern TUI command API runs these callbacks in the TUI process. The
commands do not create a session message or invoke a model. OpenCode does not
currently pass inline arguments to model-free plugin slash commands, so
`/pr-attach URL` is deliberately unsupported; selecting `/pr-attach` opens the
prompt instead.

### Shared State

Attachments are stored beneath the user's OpenCode data directory in an
`opencode-pr-tracker` subdirectory. Each session has its own JSON file:

```json
{
  "version": 1,
  "pullRequests": [
    {
      "url": "https://github.com/owner/repository/pull/123",
      "attachedAt": "2026-08-03T12:00:00.000Z"
    }
  ]
}
```

State files contain attachment identity only. Polled GitHub data remains in TUI
memory and is refreshed when a session is opened. Writes use a temporary file
and atomic rename. Unknown schema versions fail closed and leave the original
file untouched.

The storage module derives safe filenames from the opaque session ID rather
than treating it as a path. It limits each session to 20 attached PRs to bound
rendering and polling work.

## Input Validation

The only accepted input form is:

```text
https://github.com/<owner>/<repository>/pull/<positive-integer>
```

Validation rejects alternate schemes, credentials, ports, query strings,
fragments, extra path components, and non-GitHub hosts. Accepted URLs are
reconstructed from parsed owner, repository, and PR number fields before they
are stored or opened.

## Polling and GitHub Access

The sidebar starts a poll immediately when it mounts, then every 60 seconds
until it unmounts or the TUI plugin is disposed. A backgrounded terminal tab
continues polling because its OpenCode process remains alive. Closing the tab
stops its timer. Separate Herdr tabs poll independently, including when two tabs
track the same PR.

The poller invokes `gh` with `execFile` and a fixed argument vector. It never
uses a shell or interpolates input into a command string. `gh pr view` returns
the PR title, lifecycle state, URL, and check rollup. The plugin relies on the
user's existing `gh` authentication and does not access credential files or
environment tokens directly.

Only open PRs continue to poll. Merged and closed PRs keep their last metadata
in memory and remain attached until explicitly detached.

When the agent tool changes the attachment file, normal session events cause
the TUI to reload attachments. The 60-second refresh also provides eventual
reconciliation if an event is missed. Manual TUI changes update the sidebar
immediately.

## Status Model

Lifecycle state takes precedence over CI state:

| State | Appearance |
| --- | --- |
| Merged | Purple and strikethrough |
| Closed without merge | Red and strikethrough |
| Open, all checks successful | Green |
| Open, one or more checks pending | Yellow |
| Open, one or more checks failed | Red |
| Open, no checks reported | Gray |
| GitHub status unavailable | Gray with `status unavailable` text |

For an open PR, any failed check makes the aggregate state failed. Otherwise,
any pending check makes it pending. Otherwise, one or more completed successful
checks makes it passed. Neutral and skipped checks do not cause failure.

Each row shows `owner/repository#number`, the PR title, and the state label. A
mouse click opens the canonical URL with `open` on macOS or `xdg-open` on Linux,
using `execFile` with a fixed executable and one validated URL argument.

## Failure Handling

- Missing or unauthenticated `gh`: keep attachments visible and show status as
  unavailable.
- GitHub API or network failure: retain the last successful in-memory status
  and mark it stale; do not emit a toast every polling cycle.
- Invalid manual input: keep the dialog open and show a validation error.
- Invalid agent input: return a structured tool error without changing state.
- Corrupt state file: do not overwrite it; show a single actionable error and
  treat the session as having no readable attachments.
- Concurrent state changes: atomic replacement prevents partial JSON. Before a
  write, reload the current file and apply the requested idempotent operation.

## Supply-Chain Controls

- Keep source, generated distribution files, and release history in the public
  `hcrosse/opencode-pr-tracker` repository.
- Install the initial version from a reviewed local checkout through `file://`
  entries in OpenCode's server and TUI plugin configuration.
- Do not publish to npm in the initial version.
- Use TypeScript and the minimum OpenCode/OpenTUI packages required by the
  public plugin APIs.
- Pin direct dependencies exactly and commit the package lockfile.
- Run dependency installation with lifecycle scripts disabled.
- Do not add runtime telemetry, network clients, install scripts, or binary
  downloads.
- Pin every GitHub Actions dependency to a full commit SHA.
- Enable GitHub dependency and secret scanning for the public repository.

## Repository Shape

```text
src/
  server.ts
  tui.tsx
  state.ts
  github.ts
  url.ts
test/
  state.test.ts
  github.test.ts
  url.test.ts
docs/superpowers/specs/
  2026-08-03-opencode-pr-tracker-design.md
```

`url.ts` parses and canonicalizes PR URLs. `state.ts` owns persistence.
`github.ts` invokes `gh` and maps check results. The server and TUI entry points
coordinate these modules but do not duplicate domain logic.

## Verification

Automated tests cover:

- Accepted and rejected URL forms.
- Canonical URL reconstruction.
- Session isolation, deduplication, limits, detach behavior, and corrupt files.
- Atomic persistence and read-before-write updates.
- CI aggregation for successful, pending, failed, neutral, skipped, absent, and
  malformed check data.
- Lifecycle-state precedence over CI state.
- Fixed `gh` arguments using an injected fake process runner.
- Agent tool session scoping.
- TUI command attachment and detachment behavior.

Repository checks run TypeScript typechecking, unit tests, a production build,
and a clean-distribution check. No automated test calls GitHub or requires real
credentials.

## Acceptance Criteria

1. An agent can attach a valid PR with `pr_attach`, and only its current session
   gains the attachment.
2. A user can select `/pr-attach`, enter a valid URL, and see the PR appear
   without a model call.
3. Every open Herdr tab polls its displayed session independently and stops
   when that OpenCode process closes.
4. The sidebar updates open PRs at most once per minute and renders the defined
   colors and terminal-state strikethrough.
5. Clicking a row opens only its validated canonical GitHub URL.
6. Attachments survive OpenCode restarts and remain isolated by session.
7. The package installs from a reviewed local checkout without npm publication,
   install scripts, direct token access, or shell command interpolation.
