import * as hegel from "@hegeldev/hegel"
import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"

import { layout, Row, type Entry } from "../../src/domain/StackLayout.ts"
import { consistentEntries, rendered, worlds } from "../support/stacks.ts"

describe("layout of touching Stacks", () => {
  test("closes both edges wherever two Stacks touch", () => {
    hegel.test((tc) => {
      const world = tc.draw(worlds)
      const rows = layout(consistentEntries(tc, world))

      const stackId = (row: Readonly<{ entry: Entry }>): string =>
        world.stackOf(row.entry.ref).map((member) => member.url)[0] ?? ""

      tc.note(rendered(rows).join(", "))

      for (const [before, after] of Arr.zip(rows, rows.slice(1))) {
        if (!Row.$is("PullRequest")(before) || !Row.$is("PullRequest")(after)) continue

        const touching =
          before.marker !== "bullet" &&
          after.marker !== "bullet" &&
          stackId(before) !== stackId(after)

        if (touching) {
          expect(["last", "openLast", "alone"]).toContain(before.marker)
          expect(["first", "openFirst", "alone"]).toContain(after.marker)
        }
      }
    })
  })
})
