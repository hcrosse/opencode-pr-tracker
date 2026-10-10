import { Schema } from "effect"
import { describe, expect, test } from "vitest"

import { InvalidPullRequestInput } from "../../src/domain/PullRequest.ts"
import { GitHubFailure } from "../../src/ports/GitHub.ts"
import { StoredStateInvalid } from "../../src/ports/TrackingRepository.ts"
import { Rejected, sentView, View } from "../../src/rpc.ts"
import { rejectionOf } from "../../src/server/Rpc.ts"
import { bottom, entryOf, fresh, viewOf } from "../support/ui.tsx"

describe("views sent over RPC", () => {
  test("are plain JSON data that clients decode back to the view", () => {
    const view = viewOf([entryOf(bottom, fresh(bottom, "Bottom"))])
    const sent = sentView(view)

    expect(JSON.parse(JSON.stringify(sent))).toStrictEqual(sent)
    expect(Schema.decodeUnknownSync(View)(sent)).toEqual(view)
  })
})

describe("rejections sent over RPC", () => {
  test("carry the failure's reason when the terminal can name it, and only its message otherwise", () => {
    const rejections = [
      new StoredStateInvalid({ sessionID: "ses_test" }),
      new GitHubFailure({ diagnostic: "AuthenticationRequired" }),
      new InvalidPullRequestInput({ input: "nonsense" }),
    ].map((failure) => rejectionOf(failure))

    expect(rejections.map((rejection) => Schema.decodeUnknownSync(Rejected)(rejection))).toEqual([
      {
        message:
          "The tracker's saved state for this session cannot be read. It has been left unchanged.",
        reason: "StoredStateInvalid",
      },
      {
        message: "GitHub needs you to sign in: run `gh auth login`, or set GH_TOKEN.",
        reason: "AuthenticationRequired",
      },
      {
        message:
          "Expected a pull request URL, such as github.com/owner/repository/pull/123, or a pull request number.",
      },
    ])
  })
})
