const conventionalTitle =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|test)(\([a-z0-9][a-z0-9._/-]*\))?!?: .*\S$/

export function isConventionalPullRequestTitle(title: string): boolean {
  return conventionalTitle.test(title)
}

if (import.meta.main) {
  const title = process.argv[2] ?? ""
  if (!isConventionalPullRequestTitle(title)) {
    console.error("Pull request title must use Conventional Commits: <type>[optional scope][!]: <description>")
    process.exitCode = 1
  }
}
