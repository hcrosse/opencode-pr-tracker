# OpenCode PR Tracker

Track GitHub pull requests from an OpenCode session. The plugin adds tools and
slash commands for attaching pull requests, then shows their lifecycle,
mergeability, and CI status in the TUI sidebar.

## Requirements

- OpenCode 1.18.15 or a compatible newer release
- [GitHub CLI](https://cli.github.com/) installed and authenticated (`gh auth status`)
- macOS or Linux to open pull requests by clicking their sidebar rows

## Install

Clone the repository somewhere it can remain on your machine:

```sh
git clone https://github.com/hcrosse/opencode-pr-tracker.git
```

The built plugin files are committed in `dist/`, so installation does not
require a build step.

## Configure

Add the server plugin to `~/.config/opencode/opencode.json` or a project's
`opencode.json`. Replace `/absolute/path/to` with the clone's absolute path.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-pr-tracker/dist/server.js"]
}
```

Add the TUI plugin to `~/.config/opencode/tui.json` or a project's `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///absolute/path/to/opencode-pr-tracker/dist/tui.js"]
}
```

Restart OpenCode after changing either file.

## Commands

- `/pr-attach` prompts for a pull request URL and attaches it to the current session.
- `/pr-open` lets you select and open an attached pull request on macOS or Linux.
- `/pr-detach` lets you select and remove an attached pull request.
- Agents can use the `pr_attach` and `pr_detach` tools when the server plugin is enabled.

The `pr_detach` tool also accepts a positive pull request number when exactly
one session attachment has that number. Use a canonical URL when repositories
have attached pull requests with the same number.

The plugin accepts canonical URLs in the form
`https://github.com/<owner>/<repository>/pull/<number>`.

## Sidebar

Each attached pull request appears with its repository, number, title, and
current state. Open and closed pull requests refresh at least once per minute
and when session activity changes. Click a row to open the pull request on
macOS or Linux.

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
