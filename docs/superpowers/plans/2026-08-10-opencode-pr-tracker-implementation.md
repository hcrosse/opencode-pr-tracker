# OpenCode PR Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally installable OpenCode server and TUI plugin that persists session-scoped GitHub pull requests and displays their lifecycle and CI status in the sidebar.

**Architecture:** Pure domain modules parse GitHub PR URLs and GitHub CLI output. An atomic JSON state adapter stores attachment identity under OpenCode's XDG data directory. Thin server and TUI entry points expose agent tools, model-free commands, polling, rendering, and browser opening through the current public plugin APIs.

**Tech Stack:** TypeScript source, Bun 1.3.14 package manager/test runner/bundler, Oxlint 1.77, Oxfmt 0.62, Node filesystem/process APIs, `@opencode-ai/plugin` 1.18.15, OpenTUI 0.4.5, SolidJS 1.9.12.

## Global Constraints

- Accept only canonicalizable `https://github.com/<owner>/<repository>/pull/<positive-integer>` URLs.
- Persist schema version 1 with at most 20 pull requests per session, using read-before-write and atomic rename.
- Invoke `gh`, `open`, and `xdg-open` with `execFile`; never invoke a shell or read GitHub tokens.
- Poll immediately and every 60 seconds while the sidebar component is mounted; stop polling on cleanup.
- Stop polling merged and closed pull requests while retaining their latest in-memory metadata.
- Pin every direct dependency exactly and install with lifecycle scripts disabled.
- Do not publish to npm or add runtime telemetry, network clients, install scripts, or binary downloads.

---

### Task 1: Package And Build Boundary

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `bunfig.toml`
- Create: `.oxlintrc.json`
- Create: `.oxfmtrc.json`
- Create: `.gitignore`

**Interfaces:**
- Produces: ESM exports `./server` for `dist/server.js` and `./tui` for `dist/tui.js`; scripts `test`, `lint`, `format`, `format:check`, `build`, and `check`.

- [ ] Create exact-version package metadata, Oxc settings, Bun's isolated-install policy, and TypeScript settings for Node ESM plus OpenTUI JSX.
- [ ] Run `bun install` and retain `bun.lock`; subsequent clean installs use `bun ci`.
- [ ] Run `bun test`; expect feature tests to execute through Bun's native TypeScript support.

### Task 2: Pull Request URL Domain

**Files:**
- Create: `src/url.ts`
- Create: `test/url.test.ts`

**Interfaces:**
- Produces: `parsePullRequestUrl(input: string): Result<PullRequestUrl, InvalidPullRequestUrl>` and `formatPullRequestRef(value: PullRequestUrl): string`.
- `PullRequestUrl` contains the branded canonical URL plus owner, repository, and positive integer number.

- [ ] Write table-driven tests for accepted canonical input and every rejected scheme, authority, path, query, fragment, and number form.
- [ ] Run `bun test test/url.test.ts`; expect failures because `src/url.ts` does not exist.
- [ ] Implement URL parsing by `URL`, exact authority/path checks, decoded segment validation, and canonical reconstruction.
- [ ] Run `bun test test/url.test.ts`; expect all URL tests to pass.

### Task 3: Atomic Session State

**Files:**
- Create: `src/state.ts`
- Create: `test/state.test.ts`

**Interfaces:**
- Consumes: `PullRequestUrl` and `parsePullRequestUrl` from `src/url.ts`.
- Produces: `createStateStore(options)` with `list(sessionID)`, `attach(sessionID, pullRequest)`, and `detach(sessionID, pullRequest)` typed result operations.
- Produces: `defaultStateDirectory()` implementing OpenCode's XDG data formula plus `opencode-pr-tracker`.

- [ ] Write tests using real temporary directories and an injected clock for isolation, deduplication, attachment limits, detach outcomes, corrupt JSON, unknown versions, unsafe session IDs, atomic replacement, and read-before-write updates.
- [ ] Run `bun test test/state.test.ts`; expect failures because the state module does not exist.
- [ ] Implement strict persisted-state parsing and hash opaque session IDs into filenames.
- [ ] Implement mkdir, temporary-file write, rename, and cleanup with expected failures returned as tagged values.
- [ ] Run `bun test test/state.test.ts`; expect all state tests to pass.

### Task 4: GitHub CLI Adapter And Status Model

**Files:**
- Create: `src/github.ts`
- Create: `test/github.test.ts`

**Interfaces:**
- Consumes: parsed `PullRequestUrl` from `src/url.ts`.
- Produces: `createGitHubClient(runner)` with `get(pullRequest, { signal? })`.
- Produces: `PullRequestStatus` tagged lifecycle/CI state and `statusAppearance(status)`.

- [ ] Write tests with a recording runner for the fixed `gh pr view <url> --json title,state,url,mergedAt,statusCheckRollup` argument vector and cancellation signal.
- [ ] Write boundary tests for lifecycle precedence and passed, pending, failed, absent, neutral, skipped, and malformed check data.
- [ ] Run `bun test test/github.test.ts`; expect failures because the GitHub module does not exist.
- [ ] Implement strict JSON parsing, check aggregation, dependency-failure classification, and the `execFile` production runner.
- [ ] Run `bun test test/github.test.ts`; expect all GitHub tests to pass.

### Task 5: Server Agent Tools

**Files:**
- Create: `src/server.ts`
- Create: `test/server.test.ts`

**Interfaces:**
- Consumes: URL parser and state store.
- Produces: default `TuiPluginModule` server entry with `pr_attach` and `pr_detach` tools scoped to `ToolContext.sessionID`.

- [ ] Write tests that execute registered tool definitions through a temporary state store and verify session isolation plus idempotent result text.
- [ ] Run `bun test test/server.test.ts`; expect failures because the server entry point does not exist.
- [ ] Implement a composition function for tests and the default OpenCode plugin export.
- [ ] Run `bun test test/server.test.ts`; expect all server tests to pass.

### Task 6: TUI Commands, Polling, And Sidebar

**Files:**
- Create: `src/tui.tsx`
- Create: `test/tui.test.ts`

**Interfaces:**
- Consumes: URL parser, state store, GitHub client, appearance model.
- Produces: default `TuiPluginModule` TUI entry registering `pr.attach`, `pr.detach`, and `sidebar_content`.
- Produces: testable command/polling orchestration through injected state, GitHub, browser, timer, and notification seams.

- [ ] Write command tests for session-route requirements, prompt validation, immediate attach refresh, detach selection, and no model message creation.
- [ ] Write polling tests for immediate refresh, 60-second cadence, terminal-state suppression, stale last-known status, and cleanup cancellation.
- [ ] Run `bun test test/tui.test.ts`; expect failures because the TUI module does not exist.
- [ ] Implement the model-free keymap commands and dialogs using `api.route.current.params.sessionID`.
- [ ] Implement Solid sidebar rendering using slot prop `session_id`, lifecycle-owned polling, theme colors, strikethrough, and safe clickable rows.
- [ ] Implement platform browser opening through a fixed `execFile` executable and canonical URL argument.
- [ ] Run `bun test test/tui.test.ts`; expect all TUI tests to pass.

### Task 7: Installation Documentation And Repository Checks

**Files:**
- Create: `README.md`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Documents: prerequisites, script-disabled local install, separate server/TUI configuration, restart requirement, commands, tools, storage, and failure behavior.
- Produces: CI that runs frozen install, Oxlint compiler diagnostics/lint, Oxfmt, tests, build, and clean-distribution verification with SHA-pinned actions.

- [ ] Document local `file://` installation and the two OpenCode configuration surfaces without adding publication instructions.
- [ ] Add a SHA-pinned CI workflow using `bun ci` and the repository check script.
- [ ] Run `bun run check`; expect Oxlint compiler diagnostics/lint, Oxfmt, tests, build, and distribution verification to pass.
- [ ] Inspect `git status --short` and `git diff --check`; expect only intentional files and no whitespace errors.

## Self-Review

- Spec coverage: URL validation, persistence, CLI polling, server tools, TUI commands/sidebar, failure behavior, supply-chain controls, and verification each map to a task.
- Known external limitation: enabling GitHub dependency and secret scanning is repository administration and cannot be represented or verified by this code change.
- Type consistency: tool context and route parameters use `sessionID`; sidebar slot properties use the API's `session_id` spelling.
- Placeholder scan: no implementation placeholder is part of a production step.
