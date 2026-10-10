/** One pull request's answer within a batch response. */
import { Option, Result, Schema } from "effect"

import type { Diagnostic } from "../../domain/Snapshot.ts"
import type { Envelope } from "./Post.ts"

/** A batch response, and the aliases of the pull requests it answers. */
export interface Answer {
  readonly envelope: Envelope
  readonly aliases: ReadonlySet<string>
}

/** GraphQL error types meaning the pull request does not exist or this token cannot see it. */
const inaccessible = new Set(["NOT_FOUND", "FORBIDDEN"])

/** Errors for `key`, or naming no alias, fail it; only its own inaccessible errors mean missing. */
function aliasFailure(answer: Answer, key: string): Option.Option<Diagnostic> {
  const diagnostics = (answer.envelope.errors ?? []).flatMap((error): Diagnostic[] => {
    const root = String((error.path ?? [])[0] ?? "")

    if (root === key) return [inaccessible.has(error.type ?? "") ? "NotFound" : "InvalidResponse"]

    return answer.aliases.has(root) ? [] : ["InvalidResponse"]
  })

  if (diagnostics.length === 0) return Option.none()

  return Option.some(diagnostics.includes("InvalidResponse") ? "InvalidResponse" : "NotFound")
}

/** What GitHub answers under an alias for a repository it found. */
const Repository = Schema.Struct({ pullRequest: Schema.NullOr(Schema.Unknown) })

/**
 * The pull request GitHub answered under `key`, still to be validated. A missing repository or
 * pull request is `NotFound`.
 */
export function pullRequestAnswer(answer: Answer, key: string): Result.Result<unknown, Diagnostic> {
  const reported = aliasFailure(answer, key)

  if (Option.isSome(reported)) return Result.fail(reported.value)

  const repository = (answer.envelope.data ?? {})[key] ?? null

  if (repository === null) return Result.fail("NotFound")

  return Result.flatMap(
    Result.fromOption(Schema.decodeUnknownOption(Repository)(repository), () => "InvalidResponse"),
    ({ pullRequest }) =>
      pullRequest === null ? Result.fail("NotFound") : Result.succeed(pullRequest),
  )
}
