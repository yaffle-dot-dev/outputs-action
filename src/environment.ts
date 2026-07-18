export interface EnvironmentResolutionInput {
  environment: string
  prNumber: string
  pullRequestNumber?: number
  issueNumber?: number
  issueIsPullRequest: boolean
  ref: string
}

function prEnvironment(prNumber: number | undefined): string | undefined {
  if (prNumber === undefined || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return undefined
  }

  return `pr-${prNumber}`
}

export function resolveEnvironment(input: EnvironmentResolutionInput): string | undefined {
  let explicitPrEnvironment: string | undefined
  if (input.prNumber) {
    explicitPrEnvironment = /^[1-9]\d*$/.test(input.prNumber)
      ? prEnvironment(Number(input.prNumber))
      : undefined
    if (!explicitPrEnvironment) {
      throw new Error("Invalid pr-number input: expected a positive safe integer")
    }
  }

  if (input.environment) {
    return input.environment
  }

  if (explicitPrEnvironment) {
    return explicitPrEnvironment
  }

  const pullRequestEnvironment = prEnvironment(input.pullRequestNumber)
  if (pullRequestEnvironment) {
    return pullRequestEnvironment
  }

  if (input.issueIsPullRequest) {
    const issueEnvironment = prEnvironment(input.issueNumber)
    if (issueEnvironment) {
      return issueEnvironment
    }
  }

  return input.ref.match(/^refs\/heads\/(.+)$/)?.[1]
}
