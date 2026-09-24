import type { ToolDomain } from "@opencode/plugin/effect/tool"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema, type Scope } from "effect"

import { appearance } from "../domain/Appearance.ts"
import { failureMessage, type RequestFailure } from "../messages.ts"
import { requests, type Change, type Services, type Settings } from "./Requests.ts"

const options = { codemode: true, namespace: "pr", pinned: true } as const

/**
 * A pull request URL or number. Agents may pass the number as text or as a JSON number.
 *
 * OpenCode validates tool input with its own copy of effect, where checks such as `Schema.Int`
 * reject every value, so tool input schemas use only unchecked types and the tracker validates.
 */
export const PullRequestArgument = Schema.Struct({
  pull_request: Schema.Union([Schema.String, Schema.Number]).annotate({
    description:
      "A pull request URL, such as github.com/owner/repository/pull/123, or a number in this repository",
  }),
})

export type PullRequestArgument = typeof PullRequestArgument.Type

type PullRequestArgumentSchema = typeof PullRequestArgument

/** The argument as the text the tracker parses. */
export const targetOf = ({ pull_request }: PullRequestArgument): string => String(pull_request)

const NoArguments = Schema.Struct({})

type NoArguments = typeof NoArguments

const asToolError = (failure: RequestFailure): Tool.Error =>
  new Tool.Error({ message: failureMessage(failure) })

const listTool = ({ monitor }: Services): Tool.Info<NoArguments> => ({
  description: "List the pull requests attached to this session, with their status.",
  execute: (_input, context) =>
    monitor.view(context.sessionID).pipe(
      Effect.map((view) => ({
        content:
          view.entries.length === 0
            ? "No pull requests are attached to this session."
            : view.entries
                .map((entry) => `- ${entry.ref.url} (${appearance(entry.status).label})`)
                .join("\n"),
      })),
      Effect.mapError(asToolError),
    ),
  input: NoArguments,
  name: "list",
  options,
})

const changeTool = (
  name: string,
  description: string,
  change: Change,
): Tool.Info<PullRequestArgumentSchema> => ({
  description,
  execute: (argument, context) =>
    change(context.sessionID, targetOf(argument)).pipe(
      Effect.map((changed) => ({ content: changed.message })),
      Effect.mapError(asToolError),
    ),
  input: PullRequestArgument,
  name,
  options,
})

/** Registers the `pr` tools, which act on the calling session. */
export function registerTools(
  tools: ToolDomain,
  services: Services,
  settings: Settings,
): Effect.Effect<unknown, never, Scope.Scope> {
  return tools.transform((editor) => {
    editor.namespace({
      description: "Pull requests attached to this session and shown in its sidebar",
      name: "pr",
    })
    const changes = requests(services, settings)

    editor.add(listTool(services))
    editor.add(
      changeTool(
        "attach",
        "Attach a pull request to this session. Attaching a GitHub Stack member attaches the whole Stack.",
        changes.attach,
      ),
    )
    editor.add(
      changeTool(
        "detach",
        "Detach a pull request from this session. Other members of its Stack stay attached.",
        changes.detach,
      ),
    )
  })
}
