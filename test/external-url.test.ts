import { describe, expect, test } from "bun:test"

import { openPullRequest } from "../src/external-url.js"
import type { ProcessRunner } from "../src/github.js"
import { pullRequest } from "./tui-fixtures.js"

describe("external pull request URLs", () => {
  test.each([
    { platform: "darwin", executable: "open" },
    { platform: "linux", executable: "xdg-open" },
  ])("opens a validated URL with $executable on $platform", async ({ platform, executable }) => {
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const runner: ProcessRunner = async (file, args) => {
      calls.push({ file, args })
      return { stdout: "" }
    }

    expect(await openPullRequest(pullRequest, { platform, runner })).toEqual({ ok: true, value: undefined })
    expect(calls).toEqual([{ file: executable, args: [pullRequest.url] }])
  })

  test("preserves the unsupported-platform message", async () => {
    const result = await openPullRequest(pullRequest, { platform: "win32" })

    expect(result).toEqual({
      ok: false,
      error: {
        tag: "UnsupportedPlatform",
        message: "Opening pull requests is unsupported on win32",
        platform: "win32",
      },
    })
  })

  test("preserves the browser process failure message", async () => {
    const cause = new Error("process failed")
    const runner: ProcessRunner = async () => {
      throw cause
    }

    expect(await openPullRequest(pullRequest, { platform: "darwin", runner })).toEqual({
      ok: false,
      error: {
        tag: "OpenPullRequestFailed",
        message: "Unable to open the pull request",
        cause,
      },
    })
  })
})
