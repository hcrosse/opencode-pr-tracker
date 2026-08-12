import { describe, expect, test } from "bun:test"

import { formatPullRequestRef, parsePullRequestUrl, type PullRequestUrl } from "../src/url.js"

describe("parsePullRequestUrl", () => {
  test("parses and canonicalizes a GitHub pull request URL", () => {
    const result = parsePullRequestUrl("https://GITHUB.COM/OpenCode-AI/OpenCode/pull/00042")

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected URL to parse")
    expect(String(result.value.url)).toBe("https://github.com/opencode-ai/opencode/pull/42")
    expect(result.value.owner).toBe("opencode-ai")
    expect(result.value.repository).toBe("opencode")
    expect(result.value.number).toBe(42)
    expect(formatPullRequestRef(result.value)).toBe("opencode-ai/opencode#42")

    // @ts-expect-error -- PullRequestUrl can only be constructed by parsePullRequestUrl
    const reconstructed: PullRequestUrl = {
      url: result.value.url,
      owner: result.value.owner,
      repository: result.value.repository,
      number: result.value.number,
    }
    void reconstructed
  })

  test("parses and canonicalizes a scheme-less GitHub pull request URL", () => {
    const result = parsePullRequestUrl("GITHUB.COM/OpenCode-AI/OpenCode/pull/00042")

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected URL to parse")
    expect(String(result.value.url)).toBe("https://github.com/opencode-ai/opencode/pull/42")
  })

  test.each([
    "http://github.com/owner/repo/pull/1",
    "git://github.com/owner/repo/pull/1",
    "https://user@github.com/owner/repo/pull/1",
    "https://github.com:443/owner/repo/pull/1",
    "https://api.github.com/owner/repo/pull/1",
    "https://github.example.com/owner/repo/pull/1",
    "https://github.com/owner/repo/pulls/1",
    "https://github.com/owner/repo/pull/",
    "https://github.com/owner/repo/pull/0",
    "https://github.com/owner/repo/pull/-1",
    "https://github.com/owner/repo/pull/1.5",
    "https://github.com/owner/repo/pull/9007199254740992",
    "https://github.com/owner/repo/pull/1/files",
    "https://github.com/owner/repo/pull/1/",
    "https://github.com/owner/repo/pull/1?diff=split",
    "https://github.com/owner/repo/pull/1#discussion",
    "https://github.com/ignored/../owner/repo/pull/1",
    "https://github.com/ignored/%2e%2e/owner/repo/pull/1",
    "https://github.com/owner\\repo/pull/1",
    "https://github.com/owner/repo\\pull\\1",
    "https://github.com/ignored\\..\\owner/repo/pull/1",
    "https://github.com/owner%2Frepo/project/pull/1",
    "https://github.com/owner/repo%2Fproject/pull/1",
    "https://github.com/own\ter/repo/pull/1",
    "https://github.com/own\ner/repo/pull/1",
    "https://github.com/own\rer/repo/pull/1",
    "user@github.com/owner/repo/pull/1",
    "github.com@evil.example/owner/repo/pull/1",
    "github.com:443/owner/repo/pull/1",
    "github.com/owner/repo/pulls/1",
    "github.com/owner/repo/pull/",
    "github.com/owner/repo/pull/1/files",
    "github.com/owner/repo/pull/1?diff=split",
    "github.com/owner/repo/pull/1#discussion",
    "github.com/ignored/../owner/repo/pull/1",
    "github.com/ignored/%2e%2e/owner/repo/pull/1",
    "github.com/owner\\repo/pull/1",
    "github.com/owner/repo\\pull\\1",
    "github.com/own\ter/repo/pull/1",
    "github.com/own\ner/repo/pull/1",
    "github.com/own\rer/repo/pull/1",
    " https://github.com/owner/repo/pull/1",
    "https://github.com/owner/repo/pull/1 ",
    "not a URL",
  ])("rejects invalid input %s", (input) => {
    expect(parsePullRequestUrl(input)).toEqual({
      ok: false,
      error: {
        tag: "InvalidPullRequestUrl",
        message:
          "Expected https://github.com/<owner>/<repository>/pull/<positive-integer> or github.com/<owner>/<repository>/pull/<positive-integer>",
      },
    })
  })
})
