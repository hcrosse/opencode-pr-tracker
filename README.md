# OpenCode PR Tracker

Track GitHub pull requests from an OpenCode session. The plugin adds tools and
slash commands for attaching pull requests, then shows their lifecycle,
mergeability, and CI status in the TUI sidebar.

## Requirements

- OpenCode `>=1.18.15 <2`
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

- `/pr-attach` accepts a pull request URL, with or without `https://`, or a positive pull request number for the current GitHub repository.
- `/pr-open` lets you select and open an attached pull request on macOS or Linux.
- `/pr-detach` lets you select and remove an attached pull request.
- `/pr-sync` immediately refreshes attached pull request status.
- `/pr-tracker-feedback` collects bug reports, feature requests, or other feedback and previews optional diagnostics. It opens a prefilled browser issue by default, with confirmed `gh` submission as an alternative. Diagnostics never automatically include session content, local paths, repository names, or pull request URLs.
- `/pr-tracker-plugin-update` checks for a compatible plugin release and shows the update command.
- Agents can use the `pr_list`, `pr_attach`, and `pr_detach` tools when the server plugin is enabled.

The `pr_detach` tool also accepts a positive pull request number when exactly
one session attachment has that number. Use a pull request URL when repositories
have attached pull requests with the same number.

The plugin accepts pull request URLs in the forms
`https://github.com/<owner>/<repository>/pull/<number>` and
`github.com/<owner>/<repository>/pull/<number>`.

## Sidebar

Each attached pull request appears with its repository, number, title, and
current state. Open and closed pull requests refresh at least once per minute
and when session activity changes. Click a row to open the pull request on
macOS or Linux. When more than two pull requests are attached, click the
**Pull requests** heading to collapse or expand its rows. Status refreshes
continue while the section is collapsed.

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
