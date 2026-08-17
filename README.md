# OpenCode PR Tracker

Track GitHub pull requests from an OpenCode session. The plugin adds tools and
slash commands for attaching pull requests, then shows their lifecycle,
mergeability, and CI status in the TUI sidebar.

## Requirements

- [OpenCode](https://opencode.ai/) `>=1.18.15 <2`
- [GitHub CLI](https://cli.github.com/) installed and authenticated (`gh auth status`)
- macOS or Linux to open pull requests by clicking their sidebar rows

## Install

Install the server and TUI plugins:

```sh
opencode plugin @hcrosse/opencode-pr-tracker
```

OpenCode adds the package to both `opencode.json` and `tui.json`. To pin a
specific release, include its exact version:

```sh
opencode plugin @hcrosse/opencode-pr-tracker@0.1.0
```

Restart OpenCode after installation.

## Update

OpenCode caches installed npm plugins and does not update them automatically.
Install each new release by its exact version with `--force`:

```sh
opencode plugin @hcrosse/opencode-pr-tracker@0.2.0 --global --force
```

Replace `0.2.0` with the version you want. Omit `--global` for a plugin installed
in the current project.

The plugin checks for compatible stable releases at most once every 24 hours.
When an update is available, the sidebar shows its version. Click it or run
`/pr-tracker-plugin-update` to see the exact command for the current installation
scope. The plugin never installs updates automatically.

## Commands

- `/pr-attach` accepts a pull request URL, with or without `https://`, or a positive pull request number for the current GitHub repository. Attaching any GitHub Stack member attaches the complete stack in bottom-to-top order.
- `/pr-open` lets you select and open an attached pull request on macOS or Linux.
- `/pr-detach` lets you select and remove one attached pull request. Stack members are detached individually; detaching one member does not detach the rest of its stack.
- `/pr-sync` immediately refreshes attached pull request status.
- `/pr-tracker-plugin-update` checks for a compatible plugin release and shows the update command.
- Agents can use the `pr_list`, `pr_attach`, `pr_detach`, and `pr_feedback` tools when the server plugin is enabled.

The `pr_feedback` tool first returns an exact preview following the repository's
[bug](.github/ISSUE_TEMPLATE/bug_report.md) or
[feature](.github/ISSUE_TEMPLATE/feature_request.md) template. The agent must
show that preview with OpenCode's native question tool before opening the
prefilled browser issue or submitting it with GitHub CLI. Optional diagnostics
contain only plugin version, OpenCode version, and operating system. The tool
never automatically reads session content, attachments, local paths,
repository names, or pull request URLs. After approved delivery, the agent
returns the resulting URL in chat.

The `pr_detach` tool also accepts a positive pull request number when exactly
one session attachment has that number. Use a pull request URL when repositories
have attached pull requests with the same number.

The plugin accepts pull request URLs in the forms
`https://github.com/<owner>/<repository>/pull/<number>` and
`github.com/<owner>/<repository>/pull/<number>`.

## Compact layout

Set the TUI plugin's `layout` option in `tui.json` to show compact sidebar
entries:

```json
{
  "plugin": [["@hcrosse/opencode-pr-tracker/tui", { "layout": "compact" }]]
}
```

Only the exact `"compact"` value changes the layout. Omitting `layout` or using
any other value keeps the default two-line rows with pull request titles.
Compact rows omit the title but retain the list bullet, pull request reference,
and status on one line. Stack gaps remain visible, so compact layout has one row
per attached pull request plus any internal gaps.

## Sidebar

Each attached pull request appears with its repository, number, title, and
current state. GitHub Stack members appear together in bottom-to-top order,
from the pull request closest to the trunk through the top pull request. Open
and closed pull requests refresh at least once per minute and when session
activity changes. Click a row to open the pull request on macOS or Linux. When
more than two pull requests are attached, click the **Pull requests** heading
to collapse or expand its rows. Status refreshes continue while the section is
collapsed.

Ordinary `•` bullets identify standalone pull requests or membership that has
not been resolved yet. Validated Stack boundaries use `┌─`, `├─`, and `└─`.
`├┄ N PR(s) not attached` identifies internal gaps. Missing ranges outside the
attached members use open boundary markers rather than extra rows. The default
layout uses title connectors, while compact layout omits titles and retains one
row per attached pull request plus internal gaps. Transient refresh failures
retain the last valid Stack presentation.

| State                    | Appearance            |
| ------------------------ | --------------------- |
| Merged                   | Purple, strikethrough |
| Closed                   | Red, strikethrough    |
| Merge conflict           | Red                   |
| Checks passed            | Green                 |
| Checks pending           | Yellow                |
| Checks failed            | Red                   |
| No checks or unavailable | Gray                  |

Merged and closed states take precedence. For open pull requests, merge
conflicts take precedence over CI status.

If a refresh fails, the sidebar keeps the last successful status and marks it
as stale. Merged pull requests remain attached but stop refreshing.
