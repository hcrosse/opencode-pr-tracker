import type { Plugin } from "@opencode/plugin/effect"
import { Option, Schema } from "effect"

import { ReviewMode } from "../domain/Review.ts"
import { Layout } from "../rpc.ts"

/** The plugin's settings from its options in OpenCode's configuration. */
export interface PluginSettings {
  readonly layout: Layout
  readonly reviews: ReviewMode
}

const decodeLayout = Schema.decodeUnknownOption(Schema.Struct({ layout: Layout }))

const decodeReviews = Schema.decodeUnknownOption(Schema.Struct({ reviews: ReviewMode }))

/**
 * Each option is read on its own, so an invalid one takes its default without resetting the others.
 * The layout is "compact" unless it is "full", and review state is "off" unless it is "all".
 */
export function settingsOf(options: Plugin.Context["options"]): PluginSettings {
  return {
    layout: Option.match(decodeLayout(options), {
      onNone: (): Layout => "compact",
      onSome: ({ layout }) => layout,
    }),
    reviews: Option.match(decodeReviews(options), {
      onNone: (): ReviewMode => "off",
      onSome: ({ reviews }) => reviews,
    }),
  }
}
