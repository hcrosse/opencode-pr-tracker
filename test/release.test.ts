import { expect, test } from "bun:test"

import { isConventionalPullRequestTitle } from "../scripts/check-pr-title.js"

interface WorkflowStep {
  env?: Record<string, string>
  id?: string
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

interface WorkflowJob {
  if?: string
  needs?: string | string[]
  outputs?: Record<string, string>
  permissions?: Record<string, string>
  steps: WorkflowStep[]
  strategy?: { matrix: { include: Array<{ command: string; name: string }> } }
}

interface Workflow {
  concurrency?: { "cancel-in-progress": boolean; group: string }
  jobs: Record<string, WorkflowJob>
}

async function readWorkflow(name: string): Promise<Workflow> {
  const source = await Bun.file(new URL(`../.github/workflows/${name}`, import.meta.url)).text()
  return Bun.YAML.parse(source) as Workflow
}

function job(workflow: Workflow, name: string): WorkflowJob {
  const result = workflow.jobs[name]
  if (result === undefined) throw new Error(`Workflow job ${name} is missing`)
  return result
}

function step(workflowJob: WorkflowJob, name: string): WorkflowStep {
  const result = workflowJob.steps.find((candidate) => candidate.name === name)
  if (result === undefined) throw new Error(`Workflow step ${name} is missing`)
  return result
}

test.each([
  "feat: add npm installation",
  "fix(tui): retain stale status",
  "feat!: remove legacy configuration",
  "chore(main): release 0.1.0",
])("accepts conventional pull request title %s", (title) => {
  expect(isConventionalPullRequestTitle(title)).toBe(true)
})

test.each(["Add npm installation", "feature: add npm installation", "feat add npm installation", "feat: "])(
  "rejects non-conventional pull request title %s",
  (title) => {
    expect(isConventionalPullRequestTitle(title)).toBe(false)
  },
)

test("the title workflow uses the local validator", async () => {
  const workflow = await readWorkflow("pr-title.yml")
  const title = job(workflow, "title")

  expect(title.steps.some((candidate) => candidate.run?.includes("scripts/check-pr-title.ts"))).toBe(true)
})

test("package metadata defines the public plugin contract", async () => {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()

  expect(manifest).toMatchObject({
    name: "@hcrosse/opencode-pr-tracker",
    main: "./dist/server.js",
    exports: {
      "./server": { import: "./dist/server.js" },
      "./tui": { import: "./dist/tui.js" },
    },
    files: ["dist", "README.md", "LICENSE"],
    publishConfig: { access: "public" },
    engines: { node: ">=22.12.0", opencode: ">=1.18.15 <2" },
  })
})

test("the lockfile records the scoped root workspace name", async () => {
  const lockfile = await Bun.file(new URL("../bun.lock", import.meta.url)).text()
  expect(lockfile).toContain('"": {\n      "name": "@hcrosse/opencode-pr-tracker"')
})

test("release please starts at 0.1.0 with pre-major minor bumps", async () => {
  const config = await Bun.file(new URL("../release-please-config.json", import.meta.url)).json()
  const manifest = await Bun.file(new URL("../.release-please-manifest.json", import.meta.url)).json()

  expect(config).toMatchObject({
    "release-type": "node",
    "initial-version": "0.1.0",
    "bump-minor-pre-major": true,
    "include-component-in-tag": false,
    "changelog-path": "CHANGELOG.md",
    packages: { ".": {} },
  })
  expect(manifest).toEqual({})
})

test("the OpenCode smoke test resolves the scoped npm installation root", async () => {
  const smoke = await Bun.file(new URL("../scripts/smoke-opencode.ts", import.meta.url)).text()
  expect(smoke).toContain('join(installDirectory, "node_modules", "@hcrosse", "opencode-pr-tracker")')
})

test("CI keeps Package and Build output verification", async () => {
  const check = job(await readWorkflow("ci.yml"), "check")
  const names = check.strategy?.matrix.include.map((entry) => entry.name)
  const verify = step(check, "Verify build output")

  expect(names).toContain("Build")
  expect(names).toContain("Package")
  expect(verify.if).toBe("matrix.name == 'Build'")
})

test("release packaging is serialized and checks out the exact tag", async () => {
  const workflow = await readWorkflow("release.yml")
  const packageJob = job(workflow, "package")

  expect(workflow.concurrency).toEqual({ group: "release", "cancel-in-progress": false })
  expect(packageJob.needs).toBe("release")
  expect(packageJob.if).toBe("${{ needs.release.outputs.release_created == 'true' }}")
  expect(step(packageJob, "Check out release tag").with?.ref).toBe("${{ needs.release.outputs.tag_name }}")
})

test("the package artifact is uploaded and downloaded by ID without an archive wrapper", async () => {
  const workflow = await readWorkflow("release.yml")
  const packageJob = job(workflow, "package")
  const publish = job(workflow, "publish")
  const upload = step(packageJob, "Upload package artifact")
  const download = step(publish, "Download package artifact")
  const verify = step(publish, "Verify package artifact")

  expect(packageJob.outputs).toEqual({
    artifact_id: "${{ steps.upload.outputs.artifact-id }}",
    sha256: "${{ steps.package.outputs.sha256 }}",
  })
  expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/)
  expect(upload.with).toMatchObject({ path: "${{ steps.package.outputs.path }}", archive: false })
  expect(download.uses).toMatch(/^actions\/download-artifact@[0-9a-f]{40}$/)
  expect(download.with?.["artifact-ids"]).toBe("${{ needs.package.outputs.artifact_id }}")
  expect(verify.run).toContain('test "${#artifacts[@]}" -eq 1')
  expect(verify.run).toContain("sha256sum --check --strict")
})

test("OIDC is isolated to artifact verification and publication", async () => {
  const workflow = await readWorkflow("release.yml")
  const release = job(workflow, "release")
  const packageJob = job(workflow, "package")
  const publish = job(workflow, "publish")

  expect(release.permissions).toEqual({})
  expect(packageJob.permissions).toEqual({ contents: "read" })
  expect(publish.permissions).toEqual({ contents: "read", "id-token": "write" })
  expect(publish.needs).toBe("package")
  expect(step(publish, "Set up Node.js").uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/)
  expect(publish.steps.some((candidate) => candidate.uses?.startsWith("actions/checkout@"))).toBe(false)

  const publishCommand = step(publish, "Publish package").run
  expect(publishCommand).toContain("${{ steps.package.outputs.path }}")
  expect(publishCommand).toContain("--access public")
  expect(publishCommand).toContain("--ignore-scripts")
})
