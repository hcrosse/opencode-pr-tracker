import { describe, expect, test } from "bun:test"

import { Effect, Exit, Fiber, Option, Result } from "effect"

import {
  PullRequestUnavailable,
  StackIncomplete,
  type TrackerApi,
} from "../../src/application/Tracker.ts"
import {
  parsePullRequestUrl,
  PullRequestInput,
  type PullRequestRef,
} from "../../src/domain/PullRequest.ts"
import { Membership } from "../../src/domain/StackLayout.ts"
import { maximumAttachments } from "../../src/domain/Tracking.ts"
import { ItemResult, RepositoryUnavailable } from "../../src/ports/GitHub.ts"
import { openState, reported, reportOf, standalone } from "../support/application.ts"
import { numbers, ref, run, world } from "../support/tracker.ts"

const attachAll = (
  tracker: TrackerApi,
  sessionID: string,
  refs: readonly PullRequestRef[],
): Effect.Effect<void, unknown> =>
  Effect.forEach(
    refs,
    (pullRequest: PullRequestRef) =>
      tracker.attach(sessionID, PullRequestInput.Reference({ ref: pullRequest }), "/work"),
    { discard: true },
  )

describe("Tracker attach", () => {
  test("attaches a pull request's whole Stack, bottom first", async () => {
    const setup = world()
    const stack = Membership.cases.Stack.make({ id: "s", members: [ref(1), ref(2), ref(3)] })

    setup.github.script(ref(2), reported(ref(2), openState, stack))

    const result = await run(setup, (tracker: TrackerApi) =>
      Effect.andThen(
        tracker.attach("session", PullRequestInput.Reference({ ref: ref(2) }), "/work"),
        tracker.list("session"),
      ),
    )

    expect(Exit.map(result, numbers)).toEqual(Exit.succeed([1, 2, 3]))
  })

  test("resolves a bare number in the session's repository", async () => {
    const setup = world()

    setup.github.checkout("/work", "https://github.com/acme/api")

    const result = await run(setup, (tracker: TrackerApi) =>
      tracker.attach("session", PullRequestInput.Number({ number: 7 }), "/work"),
    )

    expect(Exit.map(result, (attached) => attached.ref.url)).toEqual(Exit.succeed(ref(7).url))
  })
})

interface Rejection {
  readonly input: PullRequestInput
  readonly directory: string
  readonly error: PullRequestUnavailable | RepositoryUnavailable
}

const rejections: readonly (readonly [string, Rejection])[] = [
  [
    "a pull request GitHub cannot find",
    {
      directory: "/work",
      input: PullRequestInput.Reference({ ref: ref(99) }),
      error: new PullRequestUnavailable({ diagnostic: "NotFound", url: ref(99).url }),
    },
  ],
  [
    "a number outside a GitHub repository",
    {
      directory: "/elsewhere",
      input: PullRequestInput.Number({ number: 7 }),
      error: new RepositoryUnavailable({ directory: "/elsewhere" }),
    },
  ],
]

describe("Tracker attach rejections", () => {
  test.each(rejections)("rejects %s and stores nothing", async (_name, rejection) => {
    const setup = world()

    const result = await run(setup, (tracker: TrackerApi) =>
      tracker.attach("session", rejection.input, rejection.directory),
    )

    expect(Exit.findErrorOption(result)).toMatchObject(Option.some(rejection.error))
    expect(setup.storage.values.size).toBe(0)
  })

  test("rejects a pull request whose Stack GitHub reported only in part, and stores nothing", async () => {
    const setup = world()

    setup.github.script(ref(1), ItemResult.Reported({ report: reportOf(ref(1), openState) }))

    const result = await run(setup, (tracker: TrackerApi) =>
      tracker.attach("session", PullRequestInput.Reference({ ref: ref(1) }), "/work"),
    )

    expect(Exit.findErrorOption(result)).toMatchObject(
      Option.some(new StackIncomplete({ url: ref(1).url })),
    )
    expect(setup.storage.values.size).toBe(0)
  })
})

describe("Tracker attachment limit", () => {
  test("rejects the attachment beyond the limit and keeps the session unchanged", async () => {
    const result = await run(world(), (tracker: TrackerApi) =>
      Effect.gen(function* () {
        yield* attachAll(
          tracker,
          "session",
          Array.from({ length: maximumAttachments }, (_, index: number) => ref(index + 1)),
        )

        const rejected = yield* Effect.flip(
          tracker.attach(
            "session",
            PullRequestInput.Reference({ ref: ref(maximumAttachments + 1) }),
            "/work",
          ),
        )

        return { rejected: rejected._tag, tracking: (yield* tracker.list("session")).length }
      }),
    )

    expect(result).toEqual(
      Exit.succeed({ rejected: "AttachmentLimitReached", tracking: maximumAttachments }),
    )
  })
})

describe("Tracker concurrency", () => {
  test("keeps every attachment made at once to one session, in request order", async () => {
    const result = await run(world(), (tracker: TrackerApi) =>
      Effect.andThen(
        Effect.forEach(
          [5, 3, 9, 1, 7],
          (number: number) =>
            tracker.attach("session", PullRequestInput.Reference({ ref: ref(number) }), "/work"),
          { concurrency: "unbounded" },
        ),
        tracker.list("session"),
      ),
    )

    expect(Exit.map(result, numbers)).toEqual(Exit.succeed([5, 3, 9, 1, 7]))
  })
})

describe("Tracker session independence", () => {
  test("does not make one session wait for another", async () => {
    const setup = world()

    const result = await run(setup, (tracker: TrackerApi) =>
      Effect.gen(function* () {
        const held = yield* setup.github.hold(ref(1))

        const slow = yield* Effect.forkChild(
          tracker.attach("slow", PullRequestInput.Reference({ ref: ref(1) }), "/work"),
        )

        yield* held.started

        const fast = yield* tracker
          .attach("fast", PullRequestInput.Reference({ ref: ref(2) }), "/work")
          .pipe(Effect.timeout("1 second"))

        yield* held.release
        yield* Fiber.join(slow)

        return numbers(fast.tracking)
      }),
    )

    expect(result).toEqual(Exit.succeed([2]))
  })
})

describe("Tracker detach", () => {
  test("detaches by number only when one attachment has it", async () => {
    const setup = world()
    const other = Result.getOrThrow(parsePullRequestUrl("github.com/acme/web/pull/1"))

    setup.github.script(other, reported(other, openState, standalone))

    const result = await run(setup, (tracker: TrackerApi) =>
      Effect.gen(function* () {
        yield* attachAll(tracker, "session", [ref(1), other, ref(2)])

        const ambiguous = yield* Effect.flip(
          tracker.detach("session", PullRequestInput.Number({ number: 1 })),
        )

        const removal = yield* tracker.detach("session", PullRequestInput.Number({ number: 2 }))
        const removed = Option.map(removal.removed, (found: PullRequestRef) => found.number)

        return {
          ambiguous: ambiguous._tag,
          remaining: (yield* tracker.list("session")).length,
          removed,
        }
      }),
    )

    expect(result).toEqual(
      Exit.succeed({
        ambiguous: "AmbiguousPullRequestNumber",
        remaining: 2,
        removed: Option.some(2),
      }),
    )
  })
})

describe("Tracker forget", () => {
  test("forgets a session's attachments, and forgetting again is harmless", async () => {
    const setup = world()

    const result = await run(setup, (tracker: TrackerApi) =>
      Effect.gen(function* () {
        yield* tracker.attach("session", PullRequestInput.Reference({ ref: ref(1) }), "/work")
        yield* tracker.forget("session")
        yield* tracker.forget("session")

        return yield* tracker.list("session")
      }),
    )

    expect(result).toEqual(Exit.succeed([]))
    expect(setup.storage.values.size).toBe(0)
  })
})
