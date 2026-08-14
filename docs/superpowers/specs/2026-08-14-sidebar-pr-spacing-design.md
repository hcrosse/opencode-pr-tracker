# Sidebar Pull Request Spacing

## Goal

Render consecutive pull request entries without a blank row between them. Keep each entry's existing two-row reference/status and title layout.

## Design

`PullRequestSidebar` will render mapped pull request entries inside a dedicated vertical container with no gap. The existing parent container will retain its one-row gap so update, error, and empty-state messages remain separated from the pull request list.

The change will not alter polling, ordering, collapse behavior, status appearance, titles, or mouse handling.

## Verification

Add a render regression test with two attached pull requests. The test will assert that the rendered reference/status and title rows for both entries are four consecutive non-empty rows. Existing collapse and interaction tests will continue to cover unchanged behavior.

Run the focused pull request TUI test, then the repository's full `bun run check` verification.
