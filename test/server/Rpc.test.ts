import { describe, expect, test } from "bun:test"

import { Effect, Logger, Schema, Stream } from "effect"

import { sentView, View, type ViewData } from "../../src/rpc.ts"
import { publishView, type Publish } from "../../src/server/Rpc.ts"
import { bottom, entryOf, fresh, viewOf } from "../support/ui.tsx"

describe("views sent over RPC", () => {
  test("are plain JSON data that clients decode back to the view", () => {
    const view = viewOf([entryOf(bottom, fresh(bottom, "Bottom"))])
    const sent = sentView(view)

    expect(JSON.parse(JSON.stringify(sent))).toStrictEqual(sent)
    expect(Schema.decodeUnknownSync(View)(sent)).toEqual(view)
  })
})

interface Published {
  readonly sent: readonly ViewData[]
  /** Error lines, as Effect's JSON logger writes them. */
  readonly errors: readonly string[]
}

/** Publishes each view in turn, returning what was sent and the errors logged. */
function published(views: readonly View[]): Published {
  const sent: ViewData[] = []
  const errors: string[] = []

  const capture = Logger.map(Logger.formatJson, (line: string) => {
    if (line.includes('"level":"ERROR"')) errors.push(line)
  })

  const publish: Publish = (data: ViewData) =>
    Effect.sync(() => {
      sent.push(data)
    })

  Effect.runSync(
    Stream.fromIterable(views).pipe(
      Stream.runForEach((view: View) => publishView(publish, view)),
      Effect.provide(Logger.layer([capture])),
    ),
  )

  return { errors, sent }
}

describe("views published as updates", () => {
  test("skip a view that cannot be encoded, logging its session, and send the next", () => {
    const good = viewOf([entryOf(bottom, fresh(bottom, "Bottom"))])

    // Attachment times are whole milliseconds, so this view cannot be encoded.
    const broken = Object.assign(
      {},
      viewOf([Object.assign({}, entryOf(bottom, fresh(bottom, "Bottom")), { attachedAt: 1.5 })]),
      { sessionID: "ses_broken" },
    )

    const { errors, sent } = published([broken, good])

    expect(sent).toEqual([sentView(good)])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"sessionID":"ses_broken"')
  })
})
