# Contributing

## Setup

Install the toolchain with `mise install`, authenticate GitHub CLI, then run `mise run setup`.

## Checks

Run `bun run check` and `mise run lint` before opening a pull request. `bun run check`
runs lint, format, type checks, tests, and a package dry run. `mise run lint` adds the
prek checks for shell scripts, workflows, and data files that CI also runs.

Use Hegel property tests for parsers, normalization, serialization, and state
transitions when a general invariant is clearer than selected examples. Keep
example tests for named regressions and user-facing cases.

## Pull Requests

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) for
pull request titles, such as `feat: add npm releases`. Supported types are:

- `build`
- `chore`
- `ci`
- `docs`
- `feat`
- `fix`
- `perf`
- `refactor`
- `revert`
- `test`

Squash merges use the pull request title as the commit reaching `main`.

Before 1.0, `feat` and titles marked `!` for a breaking change create minor
releases. `fix` and `perf` create patch releases. Other types do not create a
release by default.
