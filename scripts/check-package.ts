import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const expectedPackagePaths = [
  "LICENSE",
  "README.md",
  "dist/server.js",
  "dist/server.js.map",
  "dist/tui.js",
  "dist/tui.js.map",
  "package.json",
]

interface NpmPackResult {
  exitCode: number
  stdout: string
  stderr: string
}

type RunNpmPack = (outputDirectory: string) => Promise<NpmPackResult>

interface CheckPackageOptions {
  outputDirectory?: string
  runNpmPack?: RunNpmPack
}

function extractNpmPackJson(stdout: string): unknown {
  const arrays: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < stdout.length; index += 1) {
    const character = stdout[index]
    if (start === -1) {
      if (character === "[") {
        start = index
        depth = 1
      }
      continue
    }

    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }

    if (character === '"') inString = true
    else if (character === "[") depth += 1
    else if (character === "]") {
      depth -= 1
      if (depth === 0) {
        arrays.push(stdout.slice(start, index + 1))
        start = -1
      }
    }
  }

  const [array] = arrays
  if (array === undefined || arrays.length !== 1) {
    throw new Error("Malformed npm pack JSON: expected exactly one JSON array")
  }

  try {
    return JSON.parse(array)
  } catch {
    throw new Error("Malformed npm pack JSON: npm did not return valid JSON")
  }
}

export function validatePackageContents(output: unknown): void {
  if (!Array.isArray(output) || output.length !== 1) {
    throw new Error("Malformed npm pack output: expected one package result")
  }

  const result = output[0]
  if (typeof result !== "object" || result === null || !("files" in result) || !Array.isArray(result.files)) {
    throw new Error("Malformed npm pack output: expected a files array")
  }

  const actualPaths: string[] = []
  for (const file of result.files) {
    if (typeof file !== "object" || file === null || !("path" in file) || typeof file.path !== "string") {
      throw new Error("Malformed npm pack output: expected every file to have a path")
    }
    actualPaths.push(file.path)
  }

  const missing = [...expectedPackagePaths]
  const unexpected: string[] = []
  for (const path of actualPaths) {
    const expectedIndex = missing.indexOf(path)
    if (expectedIndex === -1) unexpected.push(path)
    else missing.splice(expectedIndex, 1)
  }

  const problems: string[] = []
  if (missing.length > 0) problems.push(`Missing package files: ${missing.join(", ")}`)
  if (unexpected.length > 0) problems.push(`Unexpected package files: ${unexpected.join(", ")}`)
  if (problems.length > 0) throw new Error(problems.join("; "))
}

function packageFilename(output: unknown): string {
  if (!Array.isArray(output) || output.length !== 1) {
    throw new Error("Malformed npm pack output: expected one package result")
  }

  const result = output[0]
  if (
    typeof result !== "object" ||
    result === null ||
    !("filename" in result) ||
    typeof result.filename !== "string" ||
    basename(result.filename) !== result.filename ||
    !/^[A-Za-z0-9._-]+\.tgz$/.test(result.filename)
  ) {
    throw new Error("Malformed npm pack output: expected a package tarball filename")
  }
  return result.filename
}

async function runNpmPack(outputDirectory: string): Promise<NpmPackResult> {
  const child = Bun.spawn(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", outputDirectory], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

export async function checkPackage(options: CheckPackageOptions = {}): Promise<string | undefined> {
  const retained = options.outputDirectory !== undefined
  const outputDirectory = retained
    ? resolve(options.outputDirectory ?? "")
    : await mkdtemp(join(tmpdir(), "opencode-pr-tracker-package-"))
  if (retained && options.outputDirectory?.trim() === "") {
    throw new Error("Output directory must not be empty")
  }
  await mkdir(outputDirectory, { recursive: true })

  try {
    const result = await (options.runNpmPack ?? runNpmPack)(outputDirectory)
    if (result.exitCode !== 0) {
      const diagnostics = result.stderr.trim() || result.stdout.trim() || "no npm diagnostics"
      throw new Error(`npm pack failed with exit code ${result.exitCode}: ${diagnostics}`)
    }

    const output = extractNpmPackJson(result.stdout)
    validatePackageContents(output)
    const artifactPath = join(outputDirectory, packageFilename(output))
    try {
      if (!(await stat(artifactPath)).isFile()) throw new Error()
    } catch {
      throw new Error("npm pack did not create the reported package artifact")
    }
    return retained ? artifactPath : undefined
  } finally {
    if (!retained) await rm(outputDirectory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    const outputDirectory = args[0] === "--output-directory" && args.length === 2 ? args[1] : undefined
    if (args.length !== 0 && outputDirectory === undefined) {
      throw new Error("Usage: bun scripts/check-package.ts [--output-directory <path>]")
    }
    const artifactPath = outputDirectory === undefined ? await checkPackage() : await checkPackage({ outputDirectory })
    console.log(
      artifactPath === undefined
        ? `Package contents match expected ${expectedPackagePaths.length} files`
        : `PACKAGE_PATH=${artifactPath}`,
    )
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : "Package check failed with an unknown error")
    process.exitCode = 1
  }
}
