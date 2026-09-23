import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import { Result } from "effect"

import { appearance } from "../../src/domain/Appearance.ts"
import { parsePullRequestUrl } from "../../src/domain/PullRequest.ts"
import { failed, succeeded, type PullRequestState } from "../../src/domain/Snapshot.ts"
import { diagnostics, snapshots } from "../support/generators.ts"

const ref = Result.getOrThrow(parsePullRequestUrl("github.com/acme/api/pull/1"))

const open = (
  fields: Partial<Omit<Extract<PullRequestState, { _tag: "Open" }>, "_tag">>,
): PullRequestState => ({
  _tag: "Open",
  behind: fields.behind ?? false,
  ci: fields.ci ?? "passed",
  draft: fields.draft ?? false,
  mergeability: fields.mergeability ?? "mergeable",
})

const shown = (state: PullRequestState): readonly [string, string, boolean] => {
  const { label, strikethrough, tone } = appearance(succeeded({ ref, state, title: "Title" }))

  return [tone, label, strikethrough]
}

describe("appearance precedence", () => {
  // The precedence table from docs/behaviors.md.
  test.each([
    ["merged", { _tag: "Merged" }, ["purple", "merged", true]],
    ["closed", { _tag: "Closed" }, ["red", "closed", true]],
    [
      "conflict over failed CI and draft",
      open({ ci: "failed", draft: true, mergeability: "conflicting" }),
      ["red", "conflict", false],
    ],
    ["failed CI over draft", open({ ci: "failed", draft: true }), ["red", "failed", false]],
    ["draft over pending CI", open({ ci: "pending", draft: true }), ["gray", "draft", false]],
    ["draft over behind", open({ behind: true, draft: true }), ["gray", "draft", false]],
    ["pending CI over behind", open({ behind: true, ci: "pending" }), ["yellow", "pending", false]],
    ["behind over passed CI", open({ behind: true }), ["yellow", "behind", false]],
    ["behind with no checks", open({ behind: true, ci: "none" }), ["yellow", "behind", false]],
    ["passed", open({}), ["green", "passed", false]],
    ["no checks", open({ ci: "none" }), ["gray", "no checks", false]],
    [
      "CI while mergeability is computed",
      open({ ci: "failed", mergeability: "unknown" }),
      ["red", "failed", false],
    ],
  ] as const)("%s", (_name, state, expected) => {
    expect(shown(state)).toEqual(expected)
  })
})

describe("appearance of unloaded, unavailable and stale statuses", () => {
  test.each([
    ["GitHubCliMissing", "install gh"],
    ["AuthenticationRequired", "authenticate"],
    ["GitHubUnavailable", "GitHub unavailable"],
    ["NotFound", "inaccessible"],
    ["InvalidResponse", "invalid response"],
  ] as const)("labels an unavailable %s status %s", (diagnostic, label) => {
    expect(appearance({ _tag: "Unavailable", diagnostic })).toEqual({
      label,
      stale: false,
      strikethrough: false,
      tone: "gray",
    })
  })

  test("shows a pull request that has not loaded yet as unavailable", () => {
    expect(appearance({ _tag: "Pending" }).label).toBe("unavailable")
  })

  test("shows a stale status like its last snapshot, marked stale", () => {
    hegel.test((tc) => {
      const snapshot = tc.draw(snapshots)
      const stale = failed(succeeded(snapshot), tc.draw(diagnostics), 0)
      const fresh = appearance(succeeded(snapshot))

      expect(appearance(stale)).toEqual({
        label: fresh.label,
        stale: true,
        strikethrough: fresh.strikethrough,
        tone: fresh.tone,
      })
    })
  })
})
