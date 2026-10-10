import { defineConfig, type Plugin } from "vitest/config"

// @opentui/solid does not export its transform, so it is imported by path. If a release moves the
// file, loading this config fails instead of compiling JSX differently from the plugin build. The
// fallback is OpenTUI's documented Node compilation (babel-preset-solid with moduleName
// "@opentui/solid" and generate "universal"): https://opentui.com/docs/bindings/solid/
import { transformSolidSource } from "./node_modules/@opentui/solid/scripts/solid-transform.js"

const jsx = /\.[cm]?[jt]sx$/u

/** Compiles JSX with the transform OpenTUI's Bun plugin applies in production. */
const solid: Plugin = {
  enforce: "pre",
  name: "opentui-solid",
  transform: {
    filter: { id: jsx },
    handler: async (code, id) => ({ code: await transformSolidSource(code, { filename: id }) }),
  },
}

export default defineConfig({
  oxc: { exclude: [jsx] },
  plugins: [solid],
  resolve: {
    alias: [
      { find: /^solid-js$/u, replacement: "solid-js/dist/solid.js" },
      { find: /^solid-js\/store$/u, replacement: "solid-js/store/dist/store.js" },
    ],
  },
  ssr: { resolve: { conditions: ["bun"] } },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    server: { deps: { inline: [/@opentui[/\\]solid/u, /solid-js/u] } },
  },
})
