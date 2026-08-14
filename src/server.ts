import { tool, type Hooks, type PluginModule } from "@opencode-ai/plugin"

import packageManifest from "../package.json" with { type: "json" }
import { attachPullRequest, type AttachPullRequestFailure } from "./attach.js"
import { createFeedbackTool, type FeedbackToolDependencies } from "./feedback-tool.js"
import type { FeedbackDiagnostics } from "./feedback.js"
import { createGitHubClient, type GitHubClient } from "./github.js"
import { createStateStore, type StateStore } from "./state.js"
import { formatPullRequestRef, parsePullRequestUrl, type InvalidPullRequestUrl } from "./url.js"

export type PrToolErrorCode =
  | InvalidPullRequestUrl["tag"]
  | AttachPullRequestFailure["tag"]
  | "InvalidPullRequestNumber"
  | "AmbiguousPullRequestNumber"

export class PrToolError extends Error {
  override readonly name = "PrToolError"

  constructor(
    readonly code: PrToolErrorCode,
    message: string,
  ) {
    super(message)
  }
}

function toToolError(failure: AttachPullRequestFailure): PrToolError {
  return new PrToolError(failure.tag, failure.message)
}

function formatReferenceList(references: readonly string[]): string {
  if (references.length < 2) return references.join("")
  if (references.length === 2) return references.join(" and ")
  return `${references.slice(0, -1).join(", ")}, and ${references.at(-1)}`
}

type FeedbackDiagnosticsFetcher = (input: URL, init: Readonly<{ signal: AbortSignal }>) => Promise<Response>

type FeedbackDiagnosticsOptions = Readonly<{
  pluginVersion: string
  platform: string
  arch: string
  signal: AbortSignal
  fetcher?: FeedbackDiagnosticsFetcher
}>

function parseHealthVersion(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  if (!("healthy" in value) || value.healthy !== true) return undefined
  if (!("version" in value) || typeof value.version !== "string") return undefined
  const version = value.version.trim()
  return version === "" ? undefined : version
}

export async function readFeedbackDiagnostics(
  serverUrl: URL,
  options: FeedbackDiagnosticsOptions,
): Promise<FeedbackDiagnostics> {
  let opencodeVersion = "unavailable"
  try {
    const response = await (options.fetcher ?? fetch)(new URL("/global/health", serverUrl), {
      signal: options.signal,
    })
    if (response.ok) {
      const value: unknown = await response.json()
      opencodeVersion = parseHealthVersion(value) ?? "unavailable"
    }
  } catch (cause) {
    if (options.signal.aborted) throw cause
  }

  return {
    pluginVersion: options.pluginVersion,
    opencodeVersion,
    operatingSystem: `${options.platform}/${options.arch}`,
  }
}

const defaultFeedbackDependencies: FeedbackToolDependencies = {
  async readDiagnostics() {
    return {
      pluginVersion: packageManifest.version,
      opencodeVersion: "unavailable",
      operatingSystem: `${process.platform}/${process.arch}`,
    }
  },
  platform: process.platform,
}

export function createServerHooks(
  store: StateStore,
  github: GitHubClient = createGitHubClient(),
  feedback: FeedbackToolDependencies = defaultFeedbackDependencies,
): Hooks {
  const feedbackTool = createFeedbackTool(feedback)
  return {
    async event({ event }) {
      if (event.type !== "session.deleted") return
      feedbackTool.clearSession(event.properties.info.id)
      const result = await store.removeSession(event.properties.info.id)
      if (!result.ok) throw toToolError(result.error)
    },
    tool: {
      pr_feedback: feedbackTool,
      pr_list: tool({
        description: "List pull requests attached to the current OpenCode session.",
        args: {},
        async execute(_args, context) {
          const result = await store.list(context.sessionID)
          if (!result.ok) throw toToolError(result.error)
          if (result.value.length === 0) return "No pull requests are attached to this session."

          return `Attached pull requests:\n${result.value
            .map((attachment) => `- ${attachment.pullRequest.url}`)
            .join("\n")}`
        },
      }),
      pr_attach: tool({
        description: "Attach a GitHub pull request URL to the current OpenCode session.",
        args: {
          url: tool.schema
            .string()
            .describe(
              "A https://github.com/<owner>/<repository>/pull/<number> or github.com/<owner>/<repository>/pull/<number> URL",
            ),
        },
        async execute(args, context) {
          const pullRequest = parsePullRequestUrl(args.url)
          if (!pullRequest.ok) throw new PrToolError(pullRequest.error.tag, pullRequest.error.message)

          const result = await attachPullRequest({ store, github }, context.sessionID, pullRequest.value, {
            signal: context.abort,
          })
          if (!result.ok) throw toToolError(result.error)

          const reference = formatPullRequestRef(pullRequest.value)
          return result.value === "added"
            ? `Attached ${reference} to this session.`
            : `${reference} is already attached to this session.`
        },
      }),
      pr_detach: tool({
        description: "Detach a pull request from the current OpenCode session by positive number or GitHub URL.",
        args: {
          pull_request: tool.schema
            .union([tool.schema.number().int().positive().max(Number.MAX_SAFE_INTEGER), tool.schema.string()])
            .describe("https://github.com/owner/repository/pull/123, github.com/owner/repository/pull/123, or 123"),
        },
        async execute(args, context) {
          if (typeof args.pull_request === "number") {
            if (!Number.isSafeInteger(args.pull_request) || args.pull_request <= 0) {
              throw new PrToolError(
                "InvalidPullRequestNumber",
                "Expected 123, https://github.com/owner/repository/pull/123, or github.com/owner/repository/pull/123",
              )
            }
            const result = await store.detachByNumber(context.sessionID, args.pull_request)
            if (!result.ok) throw toToolError(result.error)
            if (result.value.tag === "absent") {
              return `Pull request #${args.pull_request} is not attached to this session.`
            }
            if (result.value.tag === "ambiguous") {
              const references = result.value.pullRequests.map(formatPullRequestRef)
              throw new PrToolError(
                "AmbiguousPullRequestNumber",
                `Pull request #${args.pull_request} matches ${formatReferenceList(references)}. Use a canonical GitHub pull request URL.`,
              )
            }
            return `Detached ${formatPullRequestRef(result.value.pullRequest)} from this session.`
          }

          const pullRequest = parsePullRequestUrl(args.pull_request)
          if (!pullRequest.ok) throw new PrToolError(pullRequest.error.tag, pullRequest.error.message)

          const result = await store.detach(context.sessionID, pullRequest.value)
          if (!result.ok) throw toToolError(result.error)

          const reference = formatPullRequestRef(pullRequest.value)
          return result.value === "removed"
            ? `Detached ${reference} from this session.`
            : `${reference} is not attached to this session.`
        },
      }),
    },
  }
}

const plugin: PluginModule & { id: string } = {
  id: "opencode-pr-tracker",
  server: async ({ serverUrl }) =>
    createServerHooks(createStateStore(), createGitHubClient(), {
      readDiagnostics: (signal) =>
        readFeedbackDiagnostics(serverUrl, {
          pluginVersion: packageManifest.version,
          platform: process.platform,
          arch: process.arch,
          signal,
        }),
      platform: process.platform,
    }),
}

export default plugin
