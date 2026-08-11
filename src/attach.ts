import { execFileRunner, type ProcessRunner } from "./github.js"
import { parsePullRequestUrl, type PullRequestUrl, type Result } from "./url.js"

export type InvalidPullRequestInput = Readonly<{
  tag: "InvalidPullRequestInput"
  message: "Expected https://github.com/<owner>/<repository>/pull/<positive-integer>, github.com/<owner>/<repository>/pull/<positive-integer>, or a positive pull request number"
}>

export type RepositoryResolutionFailed = Readonly<{
  tag: "RepositoryResolutionFailed"
  message: "Unable to resolve the current GitHub repository with gh; attach with a full URL instead"
  cause?: unknown
}>

export type RepositoryResolutionCancelled = Readonly<{
  tag: "RepositoryResolutionCancelled"
}>

export type PullRequestInputFailure =
  | InvalidPullRequestInput
  | RepositoryResolutionFailed
  | RepositoryResolutionCancelled

const invalidPullRequestInput: Result<never, InvalidPullRequestInput> = {
  ok: false,
  error: {
    tag: "InvalidPullRequestInput",
    message:
      "Expected https://github.com/<owner>/<repository>/pull/<positive-integer>, github.com/<owner>/<repository>/pull/<positive-integer>, or a positive pull request number",
  },
}

const repositoryResolutionFailed: RepositoryResolutionFailed = {
  tag: "RepositoryResolutionFailed",
  message: "Unable to resolve the current GitHub repository with gh; attach with a full URL instead",
}

const repositoryResolutionCancelled: Result<never, RepositoryResolutionCancelled> = {
  ok: false,
  error: { tag: "RepositoryResolutionCancelled" },
}

function isCancellation(cause: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  return cause instanceof Error && cause.name === "AbortError"
}

function parseRepositoryPullRequest(
  stdout: string,
  number: number,
): Result<PullRequestUrl, RepositoryResolutionFailed> {
  let decoded: unknown
  try {
    decoded = JSON.parse(stdout)
  } catch {
    return { ok: false, error: repositoryResolutionFailed }
  }
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    !("url" in decoded) ||
    typeof decoded.url !== "string" ||
    decoded.url === ""
  ) {
    return { ok: false, error: repositoryResolutionFailed }
  }

  const repositoryUrl = decoded.url.endsWith("/") ? decoded.url.slice(0, -1) : decoded.url
  const pullRequest = parsePullRequestUrl(`${repositoryUrl}/pull/${number}`)
  return pullRequest.ok ? pullRequest : { ok: false, error: repositoryResolutionFailed }
}

export async function resolvePullRequestInput(
  input: string,
  options: Readonly<{
    directory: string
    runner?: ProcessRunner
    signal?: AbortSignal
  }>,
): Promise<Result<PullRequestUrl, PullRequestInputFailure>> {
  const direct = parsePullRequestUrl(input)
  if (direct.ok) return direct
  if (input.trim() !== input || !/^\d+$/.test(input)) return invalidPullRequestInput

  const number = Number(input)
  if (!Number.isSafeInteger(number) || number <= 0) return invalidPullRequestInput

  let stdout: string
  try {
    const result = await (options.runner ?? execFileRunner)("gh", ["repo", "view", "--json", "url"], {
      cwd: options.directory,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    stdout = result.stdout
  } catch (cause) {
    if (isCancellation(cause, options.signal)) return repositoryResolutionCancelled
    return { ok: false, error: { ...repositoryResolutionFailed, cause } }
  }

  return parseRepositoryPullRequest(stdout, number)
}
