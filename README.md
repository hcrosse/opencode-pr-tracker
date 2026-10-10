# OpenCode PR Tracker

Track GitHub pull requests in an OpenCode session. Attach pull requests with a slash command or let the agent attach them, and the session's sidebar shows each one's state, checks, and mergeability, and optionally its review state.

## Requirements

- [OpenCode](https://opencode.ai/) 2, version 2.0.24 or later (OpenCode 3 is not yet supported). For OpenCode 2.0.15 to 2.0.23, use version 0.6. For OpenCode 1, use version 0.3.
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

Without an argument, `/pr-attach` asks for one. Attaching any member of a GitHub Stack also attaches the Stack's open members, bottom first. Merged and closed members are left out unless you name them. If GitHub returns only part of the Stack, nothing is attached. A session can track up to 40 pull requests.

| Command      | What it does                                                    |
| ------------ | --------------------------------------------------------------- |
| `/pr-attach` | Attaches a pull request and the open members of its Stack.      |
| `/pr-detach` | Detaches the pull request you choose. Other Stack members stay. |
| `/pr-sync`   | Refreshes every attached pull request now.                      |
| `/pr-open`   | Opens the pull request you choose in the browser.               |

The same commands appear in the command palette (ctrl+p) under **Pull requests**. Deleting a session removes its attachments.

Agents get three tools in the `pr` namespace: `pr.list`, `pr.attach` and `pr.detach`. They act on the agent's session and accept the same URLs and numbers. When several attached pull requests share a number, detach by URL.

## Sidebar

Each attached pull request shows its repository, number, status, and title. Open the sidebar with ctrl+x b if your terminal is narrow enough to hide it. Click a row to open its pull request. With more than two pull requests attached, click the **Pull requests** heading to collapse or expand the list.

Stack members appear together in Stack order, including pull requests linked into a Stack after they were attached, joined by `┌─`, `├─` and `└─`. `├┄ 2 PRs not attached` marks Stack members between attached ones. Where two Stacks touch, `╭─`, `╰─` and `╶─` close an edge that has unattached members beyond it. Other pull requests use `•`.

| Status              | Appearance             |
| ------------------- | ---------------------- |
| Merged              | Purple, struck through |
| Closed              | Red, struck through    |
| Merge conflict      | Red                    |
| Checks failed       | Red                    |
| Draft               | Gray                   |
| Checks unknown      | Gray                   |
| Checks pending      | Yellow                 |
| Merge state unknown | Gray                   |
| Behind its base     | Yellow                 |
| Checks passed       | Green                  |
| No checks           | Gray                   |

The first matching row wins. A pull request shows as behind only when its base branch requires it to be up to date. Checks count only their most recent run. A check state or merge state that GitHub added after this version of the plugin shows as unknown rather than as a state it might not be, and the plugin logs the value GitHub sent the first time it sees it.

Open and closed pull requests refresh every 15 seconds in each session you have viewed or changed since OpenCode started, until the session is deleted. Merged pull requests stop refreshing. When a refresh fails, the sidebar keeps the last status and marks it `stale`. After five minutes of failures, it shows why instead, for example `authenticate` or `GitHub unavailable`.

The heading shows the sidebar's status in a word or two:

| Heading                     | Meaning                                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pull requests**           | The list is current.                                                                                                                                                                                                                                                            |
| **Pull requests · loading** | The session's pull requests are being listed for the first time.                                                                                                                                                                                                                |
| **Pull requests · stale**   | The list may be behind, and stays shown. The sidebar has not renewed its watch on the session, by watching or listing it, for 45 seconds, or it received an update it could not read. It lists the session again as soon as it can, and the note clears once that list arrives. |
| **Pull requests · _cause_** | Listing the session failed the first time. A muted line under the heading gives the full reason.                                                                                                                                                                                |

The causes are `not running` (the tracker is not running for this session's directory), `timed out`, `unreadable state`, `sign in needed`, `gh missing`, `rate limited`, `GitHub unavailable`, `not found`, `bad response` (from GitHub), `unreadable response` (from the tracker), and `failed` for anything else.

A watch or listing that does not answer within 5 seconds counts as failed. When listing the session again fails, the rows stay shown, stale, and the sidebar tries again after its next successful watch.

### Full layout

The sidebar shows one line per pull request, without titles. To show each pull request's title too, set the `layout` option:

```jsonc
{
  "plugins": [{ "package": "@hcrosse/opencode-pr-tracker", "options": { "layout": "full" } }],
}
```

The default layout is `"compact"`.

### Review state

Review state is off by default. To show it after the status of each open pull request, drafts included, set the `reviews` option to `"all"`:

```jsonc
{
  "plugins": [{ "package": "@hcrosse/opencode-pr-tracker", "options": { "reviews": "all" } }],
}
```

A row then reads, for example, `acme/api#13 pending · changes · 2 unreplied · 1 replied`, and `pr.list` reports the same. Review state never changes the status color, and a stale row keeps its last review state. Without the option, or with `"off"`, review state is off and the plugin asks GitHub for no review data.

| Review state     | Appearance | Meaning                                                                                                                        |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `approved`       | Green      | Approved, with an approval of the latest commit                                                                                |
| `stale approval` | Yellow     | Approved, but no approval is of the latest commit                                                                              |
| `changes`        | Yellow     | Changes requested                                                                                                              |
| `review`         | Gray       | The base branch requires a review                                                                                              |
| `review unknown` | Gray       | A decision or review in a state this version doesn't know                                                                      |
| `N unreplied`    | Yellow     | Unresolved review threads the author did not answer last                                                                       |
| `N replied`      | Gray       | Unresolved review threads the author answered last                                                                             |
| `N unknown`      | Gray       | Unresolved review threads whose latest comment, which may be the latest submitted one, is in a state this version doesn't know |

When GitHub reports no decision, as when the base branch requires no review, the decision comes from the latest reviews of people with write access: any change request wins, then any review in a state this version doesn't know (`review unknown`), then any approval. If a pull request has more than 100 such reviews, only GitHub's own decision is shown, and an approval is not checked for staleness. Resolved threads aren't counted, and comments not yet submitted are ignored. Only the first 20 review threads are read, so a pull request with more shows lower bounds such as `12+ unreplied`, or `20+ threads` when none of the first 20 is unresolved.

### Invalid options

The plugin accepts only the `layout` and `reviews` options, each with the values above. An unknown option such as `"theme"`, or a value an option does not allow such as `"layout": "wide"`, stops the plugin from starting, and its sidebar section and commands are absent. OpenCode briefly shows `Plugin failed: opencode-pr-tracker` when it starts, and `/plugins` lists the plugin as failed. Select it to see an error that names every problem, for example:

```text
InvalidOptions: Invalid value "wide" for option "layout". Allowed values: "full", "compact". Unknown option "theme". Known options: "layout", "reviews".
```

Options left out take their defaults.

## Development

```sh
mise install
mise run setup
bun run check
```

`bun run check` runs lint, format, type checks, tests and a package dry run. `mise run setup` installs the prek Git hook, which applies automatic fixes and runs the static checks on each commit. `mise run format` applies every automatic fix, and `mise run lint` runs the static checks, including shell scripts and GitHub workflows, without modifying files. `bun run smoke:opencode` installs the packed plugin into a temporary project, starts OpenCode, and exercises the RPC and events against GitHub when `GH_TOKEN` is set. Set `OPENCODE_BIN` to test with a specific OpenCode binary. To verify the terminal UI, follow the project skill in `.opencode/skills/verify-tui/`.
