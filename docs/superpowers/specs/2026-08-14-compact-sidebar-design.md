# Compact Pull Request Sidebar Design

Issue: [#89](https://github.com/hcrosse/opencode-pr-tracker/issues/89)

## Decision

Add `layout: "compact"` as an optional TUI plugin setting. Compact layout renders each attached pull request on one line with its list bullet, pull request reference, and status. It omits the title. The existing two-line layout remains the default.

## Configuration Boundary

The TUI plugin entrypoint will parse the framework-provided `layout` option into a typed `"default" | "compact"` value. Missing, non-string, and unrecognized values select `"default"`. The composition root will pass the parsed layout through `registerTui` to `PullRequestSidebar` rather than exposing raw plugin options to rendering code.

This change affects only the TUI plugin. It does not change server tools, persisted attachment state, polling, or GitHub requests.

## Rendering

Default layout preserves the current row structure:

1. A status-colored row containing the bullet, pull request reference, and status.
2. A muted title row aligned after the bullet.

Compact layout renders one status-colored row containing the bullet, pull request reference, and status. Consecutive pull requests occupy consecutive rows. Existing click behavior, status color, strikethrough, wrapping, collapse behavior, update notices, failures, and empty-state rendering remain unchanged.

## Verification

Rendering tests will prove that compact layout omits titles and places consecutive pull requests on consecutive rows. Existing rendering tests will continue to prove the default two-line layout. A composition-root test will invoke the TUI plugin with `layout: "compact"` and verify that the registered sidebar slot receives compact layout.

The README will document the option, its configuration shape, the compact row contents, and the unchanged default.
