import { execFileRunner, type ProcessRunner } from "./github.js"
import type { PullRequestUrl, Result } from "./url.js"

export type OpenExternalUrlFailure =
  | Readonly<{ tag: "UnsupportedPlatform"; message: string; platform: string }>
  | Readonly<{ tag: "OpenExternalUrlFailed"; message: string; cause: unknown }>

type OpenExternalUrlOptions = Readonly<{
  platform?: string
  runner?: ProcessRunner
  signal?: AbortSignal
}>

export async function openExternalUrl(
  url: string,
  subject: string,
  options: OpenExternalUrlOptions = {},
): Promise<Result<void, OpenExternalUrlFailure>> {
  const platform = options.platform ?? process.platform
  const executable = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : undefined
  if (executable === undefined) {
    return {
      ok: false,
      error: {
        tag: "UnsupportedPlatform",
        message: `Opening ${subject} is unsupported on ${platform}`,
        platform,
      },
    }
  }

  try {
    await (options.runner ?? execFileRunner)(executable, [url], options.signal ? { signal: options.signal } : {})
    return { ok: true, value: undefined }
  } catch (cause) {
    return {
      ok: false,
      error: { tag: "OpenExternalUrlFailed", message: `Unable to open ${subject}`, cause },
    }
  }
}

export type OpenPullRequestFailure =
  | Readonly<{ tag: "UnsupportedPlatform"; message: string; platform: string }>
  | Readonly<{
      tag: "OpenPullRequestFailed"
      message: "Unable to open the pull request"
      cause: unknown
    }>

export async function openPullRequest(
  pullRequest: PullRequestUrl,
  options: OpenExternalUrlOptions = {},
): Promise<Result<void, OpenPullRequestFailure>> {
  const result = await openExternalUrl(pullRequest.url, "pull requests", options)
  if (result.ok) return result
  if (result.error.tag === "UnsupportedPlatform") {
    return {
      ok: false,
      error: result.error,
    }
  }
  return {
    ok: false,
    error: {
      tag: "OpenPullRequestFailed",
      message: "Unable to open the pull request",
      cause: result.error.cause,
    },
  }
}
