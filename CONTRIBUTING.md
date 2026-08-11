# Contributing

## Setup

Install Bun 1.3.14, authenticate GitHub CLI, then run `bun ci`.

## Checks

Run `bun run check` before opening a pull request.

## Pull Requests

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) for
pull request titles, such as `feat: add npm releases`. Supported types are
`build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, and
`test`. Squash merges use the pull request title as the commit reaching `main`.

Before 1.0, `feat` and titles marked `!` for a breaking change create minor
releases. `fix` and `perf` create patch releases. Other types do not create a
release by default.
