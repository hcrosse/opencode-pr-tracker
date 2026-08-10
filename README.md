# OpenCode PR Tracker

OpenCode PR Tracker attaches GitHub pull requests to an OpenCode session and
shows their lifecycle and CI status in the TUI sidebar.

The server plugin gives agents `pr_attach` and `pr_detach` tools. The TUI plugin
adds model-free `/pr-attach` and `/pr-detach` commands, polls open pull requests
once per minute, and opens a pull request when its sidebar row is clicked.

## Requirements

- OpenCode 1.18.15 or a compatible newer release
- Node.js 22 or newer
- Bun 1.3.14 or newer for tests
- An installed and authenticated GitHub CLI (`gh auth status`)
- macOS or Linux for clickable sidebar rows

## Install From A Local Checkout

Install the pinned dependencies under the repository's release-age and
build-script policy, then build the two plugin entry points:

```sh
bun ci
bun run check
```

Add the server plugin to `~/.config/opencode/opencode.json` or a project's
`opencode.json`. Replace the example path with the checkout's absolute path.

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

Quit and restart OpenCode after changing either config or rebuilding the
plugin. Configured plugins are loaded once when their runtime starts.

## Dependency Policy

`bunfig.toml` applies the install policy to direct and transitive packages:

- Versions must be published for at least three days before resolution.
- Dependency and project lifecycle scripts never run during installation.
- Bun auto-install, peer auto-install, fallback hoisting, and `.env` loading are disabled.
- The isolated linker prevents undeclared dependency access.
- New direct dependencies are saved with exact versions.
- `trustedDependencies` is empty, so no package can opt into lifecycle scripts.

`bun ci` verifies that `package.json` matches the committed text lockfile and
installs only its integrity-pinned resolutions. The project does not override
the user's configured registry, CA, or organization package firewall.

## Use

Agents can call:

- `pr_attach` with a GitHub pull request URL
- `pr_detach` with an attached GitHub pull request URL

Users can select:

- `/pr-attach` to enter a pull request URL
- `/pr-detach` to select an attached pull request

Only URLs shaped like
`https://github.com/<owner>/<repository>/pull/<positive-integer>` are accepted.
Query strings, fragments, credentials, ports, alternate hosts, and extra path
segments are rejected.

## Status

The sidebar gives lifecycle state precedence over CI state:

| State                    | Appearance            |
| ------------------------ | --------------------- |
| Merged                   | Purple, strikethrough |
| Closed                   | Red, strikethrough    |
| Checks passed            | Green                 |
| Checks pending           | Yellow                |
| Checks failed            | Red                   |
| No checks or unavailable | Gray                  |

When a refresh fails, the sidebar keeps the last successful result and marks it
stale. Merged and closed pull requests remain attached but stop polling.

## Storage And Security

Attachments are stored as versioned JSON under
`$XDG_DATA_HOME/opencode/opencode-pr-tracker`. The default path is
`~/.local/share/opencode/opencode-pr-tracker`. Session IDs are SHA-256 hashed
before they become filenames, and each session is limited to 20 pull requests.

The plugin invokes `gh`, `open`, and `xdg-open` with fixed argument arrays. It
does not invoke a shell, read GitHub tokens, install binaries, run install
scripts, send telemetry, or make network requests outside the authenticated
GitHub CLI.

## Development

```sh
bun test
bun run lint
bun run format:check
bun run build
bun run check
```

Generated files in `dist/` are committed so a reviewed checkout can be loaded
without compiling at OpenCode startup.
