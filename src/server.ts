import { tool, type Hooks, type PluginModule } from "@opencode-ai/plugin"

import { createStateStore, type AttachFailure, type StateStore } from "./state.js"
import { formatPullRequestRef, parsePullRequestUrl, type InvalidPullRequestUrl } from "./url.js"

export type PrToolErrorCode = InvalidPullRequestUrl["tag"] | AttachFailure["tag"]

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

export function createServerHooks(store: StateStore): Hooks {
  return {
    tool: {
      pr_attach: tool({
        description: "Attach a canonical GitHub pull request URL to the current OpenCode session.",
        args: {
          url: tool.schema.string().describe("A https://github.com/<owner>/<repository>/pull/<number> URL"),
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
        description: "Detach a canonical GitHub pull request URL from the current OpenCode session.",
        args: {
          url: tool.schema.string().describe("A https://github.com/<owner>/<repository>/pull/<number> URL"),
        },
        async execute(args, context) {
          const pullRequest = parsePullRequestUrl(args.url)
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
