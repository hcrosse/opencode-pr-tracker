/** @jsxImportSource @opentui/solid */
import { createTextAttributes, getBaseAttributes, RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { testRender } from "@opentui/solid"
import { Option } from "effect"
import { constVoid } from "effect/Function"

import type { PullRequestRef } from "../../src/domain/PullRequest.ts"
import type { PullRequestState, Status } from "../../src/domain/Snapshot.ts"
import type { Membership } from "../../src/domain/StackLayout.ts"
import type { EntryView, Layout, View } from "../../src/rpc.ts"
import type { Palette } from "../../src/ui/Palette.ts"
import { Sidebar, type SidebarState } from "../../src/ui/Sidebar.tsx"
import { ref, stack } from "./stacks.ts"

/** Distinct colors, so frames can be checked for which tone a span uses. */
export const palette: Palette = {
  muted: RGBA.fromHex("#808080"),
  text: RGBA.fromHex("#ffffff"),
  tones: {
    gray: RGBA.fromHex("#808080"),
    green: RGBA.fromHex("#00ff00"),
    purple: RGBA.fromHex("#aa00ff"),
    red: RGBA.fromHex("#ff0000"),
    yellow: RGBA.fromHex("#ffff00"),
  },
}

export const passing: PullRequestState = {
  _tag: "Open",
  behind: false,
  ci: "passed",
  draft: false,
  mergeability: "mergeable",
}

export const fresh = (
  pullRequest: PullRequestRef,
  title: string,
  state: PullRequestState = passing,
): Status => ({
  _tag: "Fresh",
  snapshot: { ref: pullRequest, state, title },
})

export const entryOf = (
  pullRequest: PullRequestRef,
  status: Status,
  membership: Membership | null = null,
): EntryView => ({ attachedAt: 0, membership, ref: pullRequest, status })

export const viewOf = (entries: readonly EntryView[], layout: Layout = "default"): View => ({
  entries,
  layout,
  sessionID: "ses_test",
})

/** How a span of text is drawn: its color and base attributes (see `createTextAttributes`). */
export interface Style {
  readonly fg: string
  readonly attributes: number
}

export interface Attributes {
  readonly bold?: boolean
  readonly italic?: boolean
  readonly strikethrough?: boolean
}

export const styled = (color: RGBA, attributes: Attributes = {}): Style => ({
  attributes: createTextAttributes(attributes),
  fg: color.toString(),
})

/** Sidebar fixtures: pull requests in acme/api and acme/web. */
export const bottom = ref("acme/api", 1)

export const second = ref("acme/api", 2)

export const third = ref("acme/api", 3)

const top = ref("acme/api", 4)

export const standalone = ref("acme/web", 9)

const fourStack = stack("s", [bottom, second, third, top])

/** A standalone pull request, then the bottom and third members of a four-member Stack. */
export const mixed = [
  entryOf(standalone, fresh(standalone, "Standalone change")),
  entryOf(bottom, fresh(bottom, "Bottom of the Stack"), fourStack),
  entryOf(
    third,
    fresh(third, "A long title that will certainly wrap onto another line"),
    fourStack,
  ),
]

export interface Rendered {
  /** The frame's lines, without trailing spaces or trailing blank lines. */
  readonly lines: () => string[]
  /** The style of the first span whose text contains `text`. */
  readonly style: (text: string) => Option.Option<Style>
  readonly click: (x: number, y: number) => Promise<void>
  readonly destroy: () => void
}

function trimmedLines(frame: string): string[] {
  const all = frame.split("\n").map((line) => line.trimEnd())

  while (all.length > 0 && all.at(-1) === "") all.pop()

  return all
}

/** The parts of a captured frame that `firstStyle` reads. */
interface SpanFrame {
  readonly lines: readonly {
    readonly spans: readonly {
      readonly text: string
      readonly attributes: number
      readonly fg: RGBA
    }[]
  }[]
}

function firstStyle(frame: SpanFrame, text: string): Option.Option<Style> {
  for (const line of frame.lines) {
    for (const span of line.spans) {
      if (span.text.includes(text)) {
        return Option.some({
          attributes: getBaseAttributes(span.attributes),
          fg: span.fg.toString(),
        })
      }
    }
  }

  return Option.none()
}

export async function render(node: () => JSX.Element, width = 44, height = 24): Promise<Rendered> {
  const setup = await testRender(node, { height, width })

  await setup.flush()

  return {
    click: async (x, y) => {
      await setup.mockMouse.click(x, y)
    },
    destroy: () => {
      setup.renderer.destroy()
    },
    lines: () => trimmedLines(setup.captureCharFrame()),
    style: (text) => firstStyle(setup.captureSpans(), text),
  }
}

const mounted: Rendered[] = []

/** Destroys every sidebar shown by `showSidebar`; register with `afterEach`. */
export function destroyMounted(): void {
  for (const rendered of mounted.splice(0)) rendered.destroy()
}

export interface SidebarOptions {
  readonly collapsed?: boolean
  readonly onOpen?: (ref: PullRequestRef) => void
  readonly onToggle?: () => void
  readonly width?: number
}

export const ready = (view: View): SidebarState => ({ _tag: "Ready", view })

export async function showSidebar(
  state: SidebarState,
  options: SidebarOptions = {},
): Promise<Rendered> {
  const rendered = await render(
    () => (
      <Sidebar
        collapsed={options.collapsed ?? false}
        onOpen={options.onOpen ?? constVoid}
        onToggle={options.onToggle ?? constVoid}
        palette={palette}
        state={state}
      />
    ),
    options.width,
  )

  mounted.push(rendered)

  return rendered
}
