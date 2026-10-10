import type { Plugin } from "@opencode/plugin/effect"
import { Schema } from "effect"

import { ReviewMode } from "../domain/Review.ts"
import { Layout } from "../rpc.ts"

/** The plugin's settings from its options in OpenCode's configuration. */
export interface PluginSettings {
  readonly layout: Layout
  readonly reviews: ReviewMode
}

const isLayout = Schema.is(Layout)

const isReviewMode = Schema.is(ReviewMode)

/**
 * Each option is read on its own, so an invalid one takes its default without resetting the others.
 * The layout is "compact" unless it is "full", and review state is "off" unless it is "all".
 */
export function settingsOf(options: Plugin.Context["options"]): PluginSettings {
  const layout: unknown = options["layout"]
  const reviews: unknown = options["reviews"]

  return {
    layout: isLayout(layout) ? layout : "compact",
    reviews: isReviewMode(reviews) ? reviews : "off",
  }
}
