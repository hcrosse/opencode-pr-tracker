import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { checkPackage, validatePackageContents } from "../scripts/check-package.js"
import { isConventionalPullRequestTitle } from "../scripts/check-pr-title.js"

const expectedPackagePaths = [
  "LICENSE",
  "README.md",
  "dist/server.js",
  "dist/server.js.map",
  "dist/tui.js",
  "dist/tui.js.map",
  "package.json",
]
const expectedPackageFilename = "hcrosse-opencode-pr-tracker-0.1.0.tgz"

function npmPackOutput(paths: string[], filename: unknown = expectedPackageFilename): unknown {
  return [{ filename, files: paths.map((path) => ({ path })) }]
}

function successfulNpmPack(stdout: string) {
  return async (outputDirectory: string) => {
    await writeFile(join(outputDirectory, expectedPackageFilename), "package archive")
    return { exitCode: 0, stdout, stderr: "" }
  }
}

async function readWorkflow(name: string): Promise<string> {
  return Bun.file(new URL(`../.github/workflows/${name}`, import.meta.url)).text()
}

function workflowJob(workflow: string, name: string): string {
  const job = workflow.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:\\n|$(?![\\s\\S]))`, "m"))
  expect(job).not.toBeNull()
  return job?.[0] ?? ""
}

function workflowStep(job: string, name: string): string {
  const step = job.match(new RegExp(`^      - name: ${name}\\n[\\s\\S]*?(?=^      - name: |$(?![\\s\\S]))`, "m"))
  expect(step).not.toBeNull()
  return step?.[0] ?? ""
}

test.each([
  "feat: add npm installation",
  "fix(tui): retain stale status",
  "feat!: remove legacy configuration",
  "chore(main): release 0.1.0",
  "fix: x",
])("accepts conventional pull request title %s", (title) => {
  expect(isConventionalPullRequestTitle(title)).toBe(true)
})

test.each(["Add npm installation", "feature: add npm installation", "feat add npm installation", "feat: ", "fix:   "])(
  "rejects non-conventional pull request title %s",
  (title) => {
    expect(isConventionalPullRequestTitle(title)).toBe(false)
  },
)

test("release please starts at 0.1.0 with pre-major minor bumps", async () => {
  const file = Bun.file(new URL("../release-please-config.json", import.meta.url))
  const exists = await file.exists()
  expect(exists).toBe(true)
  if (!exists) return

  expect(await file.json()).toMatchObject({
    "release-type": "node",
    "initial-version": "0.1.0",
    "bump-minor-pre-major": true,
    "include-component-in-tag": false,
    "changelog-path": "CHANGELOG.md",
    packages: { ".": {} },
  })
})

test("the release manifest has no published version", async () => {
  const file = Bun.file(new URL("../.release-please-manifest.json", import.meta.url))
  const exists = await file.exists()
  expect(exists).toBe(true)
  if (!exists) return
  expect(await file.json()).toEqual({})
})

test("package metadata declares the supported Node.js and OpenCode versions", async () => {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
  expect(manifest.engines).toEqual({
    node: ">=22.12.0",
    opencode: ">=1.18.15 <2",
  })
})

test("the lockfile records the scoped root workspace name", async () => {
  const lockfile = await Bun.file(new URL("../bun.lock", import.meta.url)).text()
  expect(lockfile).toContain('"": {\n      "name": "@hcrosse/opencode-pr-tracker"')
})

test("the OpenCode smoke test resolves the scoped npm installation root", async () => {
  const smoke = await Bun.file(new URL("../scripts/smoke-opencode.ts", import.meta.url)).text()
  expect(smoke).toContain('join(installDirectory, "node_modules", "@hcrosse", "opencode-pr-tracker")')
  expect(smoke).not.toContain('join(installDirectory, "node_modules", "opencode-pr-tracker")')
})

test("package validation accepts exactly the release artifacts", () => {
  expect(() => validatePackageContents(npmPackOutput(expectedPackagePaths))).not.toThrow()
})

test.each([
  { output: null },
  { output: [] },
  { output: [{ files: "not-an-array" }] },
  { output: [{ files: [{}] }] },
  { output: [{ files: [] }, { files: [] }] },
])("package validation rejects malformed npm output", ({ output }) => {
  expect(() => validatePackageContents(output)).toThrow("Malformed npm pack output")
})

test("package validation reports missing files", () => {
  expect(() => validatePackageContents(npmPackOutput(expectedPackagePaths.slice(0, -1)))).toThrow(
    "Missing package files: package.json",
  )
})

test("package validation reports extra files", () => {
  expect(() => validatePackageContents(npmPackOutput([...expectedPackagePaths, "src/server.ts"]))).toThrow(
    "Unexpected package files: src/server.ts",
  )
})

test("package validation rejects duplicate files", () => {
  expect(() => validatePackageContents(npmPackOutput([...expectedPackagePaths, "LICENSE"]))).toThrow(
    "Unexpected package files: LICENSE",
  )
})

test.each([
  { name: "missing", stdout: "wrapper output without JSON" },
  { name: "malformed", stdout: "wrapper banner\n[not-json]\nwrapper footer" },
  {
    name: "ambiguous",
    stdout: [
      JSON.stringify(npmPackOutput(expectedPackagePaths)),
      JSON.stringify(npmPackOutput(expectedPackagePaths)),
    ].join("\n"),
  },
])("package check rejects $name npm JSON", async ({ stdout }) => {
  expect(checkPackage({ runNpmPack: async () => ({ exitCode: 0, stdout, stderr: "" }) })).rejects.toThrow(
    "Malformed npm pack JSON",
  )
})

test("package check accepts npm JSON surrounded by non-JSON lines", async () => {
  const stdout = ["wrapper banner", JSON.stringify(npmPackOutput(expectedPackagePaths)), "wrapper footer"].join("\n")

  expect(checkPackage({ runNpmPack: successfulNpmPack(stdout) })).resolves.toBeUndefined()
})

test("package check reports a nonzero npm exit and its diagnostics", async () => {
  expect(
    checkPackage({ runNpmPack: async () => ({ exitCode: 1, stdout: "", stderr: "npm error detail" }) }),
  ).rejects.toThrow("npm pack failed with exit code 1: npm error detail")
})

test("package check retains the validated artifact at an absolute output path", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "package-check-test-"))
  const outputDirectory = join(temporaryRoot, "release")
  const stdout = JSON.stringify(npmPackOutput(expectedPackagePaths))

  try {
    const artifactPath = await checkPackage({ outputDirectory, runNpmPack: successfulNpmPack(stdout) })
    expect(artifactPath).toBe(resolve(outputDirectory, expectedPackageFilename))
    expect(await Bun.file(artifactPath ?? "").text()).toBe("package archive")
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test("package check removes its temporary artifact directory", async () => {
  let temporaryDirectory = ""
  const stdout = JSON.stringify(npmPackOutput(expectedPackagePaths))

  await checkPackage({
    runNpmPack: async (outputDirectory) => {
      temporaryDirectory = outputDirectory
      return successfulNpmPack(stdout)(outputDirectory)
    },
  })

  expect(temporaryDirectory).not.toBe("")
  expect(await Bun.file(temporaryDirectory).exists()).toBe(false)
})

test.each([
  { name: "missing", filename: undefined },
  { name: "non-string", filename: 42 },
  { name: "nested", filename: `nested/${expectedPackageFilename}` },
  { name: "wrong extension", filename: "hcrosse-opencode-pr-tracker-0.1.0.zip" },
])("package check rejects a $name artifact filename", async ({ filename }) => {
  const output =
    filename === undefined
      ? [{ files: expectedPackagePaths.map((path) => ({ path })) }]
      : npmPackOutput(expectedPackagePaths, filename)

  expect(
    checkPackage({ runNpmPack: async () => ({ exitCode: 0, stdout: JSON.stringify(output), stderr: "" }) }),
  ).rejects.toThrow("Malformed npm pack output: expected a package tarball filename")
})

test("package check rejects JSON for an artifact that was not created", async () => {
  expect(
    checkPackage({
      runNpmPack: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(npmPackOutput(expectedPackagePaths)),
        stderr: "",
      }),
    }),
  ).rejects.toThrow("npm pack did not create the reported package artifact")
})

test("package check performs a clean build before deterministic npm inspection", async () => {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
  expect(manifest.scripts["package:check"]).toBe("bun run build && bun ./scripts/check-package.ts")
})

test("CI keeps existing contexts and adds package inspection", async () => {
  const workflow = await readWorkflow("ci.yml")
  expect([...workflow.matchAll(/^          - name: (.+)$/gm)].map((match) => match[1])).toEqual([
    "Lint",
    "Format",
    "Test",
    "Build",
    "OpenCode smoke",
    "Package",
  ])
})

test("the Build context permits ignored dist output but rejects every non-ignored worktree change", async () => {
  const verify = workflowStep(workflowJob(await readWorkflow("ci.yml"), "check"), "Verify build output")

  expect(verify).toContain("if: matrix.name == 'Build'")
  expect(verify).toContain('test -z "$(git ls-files -- dist)"')
  expect(verify).toContain('test -z "$(git status --short --untracked-files=all)"')
})

test("release please uses the pinned GitHub App token action and inputs", async () => {
  const release = workflowJob(await readWorkflow("release.yml"), "release")
  const token = workflowStep(release, "Create GitHub App token")

  expect(token).toContain("uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0")
  expect(token).toContain("client-id: ${{ vars.APP_CLIENT_ID }}")
  expect(token).toContain("private-key: ${{ secrets.APP_PRIVATE_KEY }}")
  expect(token).toContain("permission-contents: write")
  expect(token).toContain("permission-issues: write")
  expect(token).toContain("permission-pull-requests: write")
})

test("release please receives only the GitHub App token", async () => {
  const release = workflowJob(await readWorkflow("release.yml"), "release")
  const releasePlease = workflowStep(release, "Prepare release")

  expect(release).toContain("    permissions: {}")
  expect(releasePlease).toContain("token: ${{ steps.app-token.outputs.token }}")
})

test("npm OIDC permission is isolated to the publish job", async () => {
  const workflow = await readWorkflow("release.yml")
  const release = workflowJob(workflow, "release")
  const publish = workflowJob(workflow, "publish")

  expect(release).not.toContain("id-token: write")
  expect(publish).toContain("id-token: write")
})

test("release package inspection captures the retained validated tarball", async () => {
  const publish = workflowJob(await readWorkflow("release.yml"), "publish")
  const inspect = workflowStep(publish, "Build and inspect package")
  expect(inspect).toContain("id: package")
  expect(inspect).toContain('bun ./scripts/check-package.ts --output-directory "$RUNNER_TEMP/package"')
  expect(inspect).toContain('test "$package_output" = "PACKAGE_PATH=$artifact_path"')
  expect(inspect).toContain('printf \'path=%s\\n\' "$artifact_path" >> "$GITHUB_OUTPUT"')
})

test("release publishes the exact validated tarball without lifecycle scripts", async () => {
  const publish = workflowJob(await readWorkflow("release.yml"), "publish")
  const publishPackage = workflowStep(publish, "Publish package")

  expect(publishPackage).toContain('npm publish "${{ steps.package.outputs.path }}" --access public --ignore-scripts')
  expect(publishPackage).not.toContain("npm publish --access public")
})

test("publish requires a created release and checks out its exact tag", async () => {
  const publish = workflowJob(await readWorkflow("release.yml"), "publish")
  const checkout = workflowStep(publish, "Check out release tag")

  expect(publish).toContain("if: ${{ needs.release.outputs.release_created == 'true' }}")
  expect(checkout).toContain("ref: ${{ needs.release.outputs.tag_name }}")
})
