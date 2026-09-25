# OpenCode PR Tracker

Track GitHub pull requests in an OpenCode session. Attach pull requests with a slash command or let the agent attach them, and the session's sidebar shows each one's state, checks, and mergeability.

## Requirements

- [OpenCode](https://opencode.ai/) 2.0.15 or later, from plugin version 0.4.0. For OpenCode 1, use version 0.3.
- A GitHub token: set `GH_TOKEN` or `GITHUB_TOKEN`, or sign in with the [GitHub CLI](https://cli.github.com/) (`gh auth login`).
- The GitHub CLI, to attach a pull request by number.
- macOS or Linux, to open pull requests in the browser.

## Install

```sh
opencode plugin add @hcrosse/opencode-pr-tracker
```

This adds the plugin to your global OpenCode configuration. To use it in one project instead, add it to that project's `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@hcrosse/opencode-pr-tracker"],
}
```

Update it with `opencode plugin update`.

## Attach pull requests

In a session, run `/pr-attach` followed by a pull request URL, with or without `https://`, or a number in the session's GitHub repository:

```text
/pr-attach github.com/owner/repository/pull/123
/pr-attach 123
```

Without an argument, `/pr-attach` asks for one. Attaching any member of a GitHub Stack attaches the whole Stack, bottom first. If GitHub returns only part of the Stack, nothing is attached. A session can track up to 20 pull requests.

| Command      | What it does                                                    |
| ------------ | --------------------------------------------------------------- |
| `/pr-attach` | Attaches a pull request and the rest of its Stack.              |
| `/pr-detach` | Detaches the pull request you choose. Other Stack members stay. |
| `/pr-sync`   | Refreshes every attached pull request now.                      |
| `/pr-open`   | Opens the pull request you choose in the browser.               |

The same commands appear in the command palette (ctrl+p) under **Pull requests**. Deleting a session removes its attachments.

Agents get three tools in the `pr` namespace: `pr.list`, `pr.attach` and `pr.detach`. They act on the agent's session and accept the same URLs and numbers. When several attached pull requests share a number, detach by URL.

## Sidebar

Each attached pull request shows its repository, number, status, and title. Open the sidebar with ctrl+x b if your terminal is narrow enough to hide it. Click a row to open its pull request. With more than two pull requests attached, click the **Pull requests** heading to collapse or expand the list.

Stack members appear together in Stack order, including pull requests linked into a Stack after they were attached, joined by `┌─`, `├─` and `└─`. `├┄ 2 PRs not attached` marks Stack members between attached ones. Other pull requests use `•`.

| Status          | Appearance             |
| --------------- | ---------------------- |
| Merged          | Purple, struck through |
| Closed          | Red, struck through    |
| Merge conflict  | Red                    |
| Checks failed   | Red                    |
| Draft           | Gray                   |
| Checks pending  | Yellow                 |
| Behind its base | Yellow                 |
| Checks passed   | Green                  |
| No checks       | Gray                   |

The first matching row wins. A pull request shows as behind only when its base branch requires it to be up to date. Checks count only their most recent run.

Open and closed pull requests refresh every 15 seconds in each session you have viewed or changed since OpenCode started, until the session is deleted. Merged pull requests stop refreshing. When a refresh fails, the sidebar keeps the last status and marks it `stale`. After five minutes of failures, it shows why instead, for example `authenticate` or `GitHub unavailable`.

### Compact layout

To show one line per pull request, without titles, set the `layout` option:

```jsonc
{
  "plugins": [{ "package": "@hcrosse/opencode-pr-tracker", "options": { "layout": "compact" } }],
}
```

Any other value keeps the default layout.

## Development

```sh
mise install
bun install
bun run check
```

`bun run check` runs lint, format, type checks, tests and a package dry run. `bun run smoke:opencode` installs the packed plugin into a temporary project, starts OpenCode, and exercises the RPC and events against GitHub when `GH_TOKEN` is set. Set `OPENCODE_BIN` to test with a specific OpenCode binary. To verify the terminal UI, follow the project skill in `.opencode/skills/verify-tui/`.
