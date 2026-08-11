import { tool, type Hooks, type PluginModule } from "@opencode-ai/plugin"

import { createStateStore, type AttachFailure, type StateStore } from "./state.js"
import { formatPullRequestRef, parsePullRequestUrl, type InvalidPullRequestUrl } from "./url.js"

export type PrToolErrorCode =
  | InvalidPullRequestUrl["tag"]
  | AttachFailure["tag"]
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

function toToolError(failure: AttachFailure): PrToolError {
  return new PrToolError(failure.tag, failure.message)
}

function formatReferenceList(references: readonly string[]): string {
  if (references.length < 2) return references.join("")
  if (references.length === 2) return references.join(" and ")
  return `${references.slice(0, -1).join(", ")}, and ${references.at(-1)}`
}

export function createServerHooks(store: StateStore): Hooks {
  return {
    async event({ event }) {
      if (event.type !== "session.deleted") return
      const result = await store.removeSession(event.properties.info.id)
      if (!result.ok) throw toToolError(result.error)
    },
    tool: {
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

          const result = await store.attach(context.sessionID, pullRequest.value)
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
  server: async () => createServerHooks(createStateStore()),
}

export default plugin
