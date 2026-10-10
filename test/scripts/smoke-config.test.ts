import { Config, ConfigProvider, Effect, Option, Redacted } from "effect"
import { describe, expect, test } from "vitest"

import { smokeConfig } from "../../scripts/smoke-config.ts"

const parse = async (
  environment: Readonly<Record<string, string>>,
): Promise<Config.Success<typeof smokeConfig>> => {
  const config = await Effect.runPromise(
    smokeConfig.parse(ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true })),
  )

  return config
}

describe("smoke configuration", () => {
  test.each(["", "  "])("treats %j optional values as absent", async (value) => {
    const config = await parse({ OPENCODE_BIN: value, GH_TOKEN: value, PATH: "/usr/bin" })

    expect(config.binary).toEqual(Option.none())
    expect(config.githubToken).toEqual(Option.none())
  })

  test("keeps nonblank optional values", async () => {
    const config = await parse({
      OPENCODE_BIN: "/bin/opencode",
      GH_TOKEN: "smoke-token",
      PATH: "/usr/bin",
    })

    expect(config.binary).toEqual(Option.some("/bin/opencode"))
    expect(Option.map(config.githubToken, (token) => Redacted.value(token))).toEqual(
      Option.some("smoke-token"),
    )
    expect(config.path).toBe("/usr/bin")
  })
})
