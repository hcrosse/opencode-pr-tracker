import { describe, expect, test } from "bun:test"

import { Schema } from "effect"

import { sentView, View } from "../../src/rpc.ts"
import { bottom, entryOf, fresh, viewOf } from "../support/ui.tsx"

describe("views sent over RPC", () => {
  test("are plain JSON data that clients decode back to the view", () => {
    const view = viewOf([entryOf(bottom, fresh(bottom, "Bottom"))])
    const sent = sentView(view)

    expect(JSON.parse(JSON.stringify(sent))).toStrictEqual(sent)
    expect(Schema.decodeUnknownSync(View)(sent)).toEqual(view)
  })
})
