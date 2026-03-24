import * as core from "@actions/core"
import * as github from "@actions/github"
import { EventSource } from "eventsource"

interface WorkspaceDeployment {
  id: string
  workspacePath: string
  status: string
}

interface EnvironmentWorkspace {
  preview: WorkspaceDeployment
  runs: unknown[]
  outputs: Record<string, TerraformOutput> | null
}

interface EnvironmentSnapshot {
  org: string
  repo: string
  environmentKind: "named" | "transient"
  environmentName: string
  workspaces: EnvironmentWorkspace[]
}

interface EnvironmentStreamUpdate {
  data: EnvironmentSnapshot | null
}

interface TerraformOutput {
  value: unknown
  type?: string
  sensitive?: boolean
}

function normalizeToken(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return ""
  }

  const withoutBearer = trimmed.match(/^Bearer\s+(.+)$/i)
  if (withoutBearer) {
    return withoutBearer[1].trim()
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed === "string") {
        return parsed.trim()
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>
        const candidate = obj.token
          ?? obj.apiToken
          ?? obj.yaffleApiToken
          ?? obj.YAFFLE_API_TOKEN
        if (typeof candidate === "string") {
          return candidate.trim()
        }
      }
    } catch {
      // Not JSON, fall through and return the original trimmed token.
    }
  }

  return trimmed
}

async function run(): Promise<void> {
  try {
    const apiUrl = core.getInput("api-url")
    const rawToken = core.getInput("token") || process.env.YAFFLE_API_TOKEN || ""
    const token = normalizeToken(rawToken)
    const workspace = core.getInput("workspace") || "."
    const headShaInput = core.getInput("head-sha")
    const wait = core.getInput("wait") === "true"
    const waitTimeout = parseInt(core.getInput("wait-timeout") || "300", 10)

    // Determine org, repo, and environment
    const context = github.context
    const org = core.getInput("org") || context.repo.owner
    const repo = core.getInput("repo") || context.repo.repo
    let environment = core.getInput("environment")
    let prNumber = parseInt(core.getInput("pr-number") || "0", 10)
    const contextHeadSha = context.payload.pull_request?.head?.sha
      || context.sha
      || ""
    const headSha = (headShaInput || contextHeadSha).trim()

    // Determine environment from context if not provided
    if (!environment) {
      if (prNumber) {
        // PR number provided explicitly
        environment = `prvw-${prNumber}`
      } else if (context.payload.pull_request) {
        // Running in PR context
        prNumber = context.payload.pull_request.number
        environment = `prvw-${prNumber}`
      } else if (context.payload.issue?.pull_request) {
        // Running in issue context with PR
        prNumber = context.payload.issue.number
        environment = `prvw-${prNumber}`
      } else if (context.ref) {
        // Running on a branch (e.g., push to main)
        // Extract branch name from refs/heads/main -> main
        const refMatch = context.ref.match(/^refs\/heads\/(.+)$/)
        if (refMatch) {
          environment = refMatch[1]
        }
      }
    }

    if (!environment) {
      throw new Error(
        "Could not determine environment. Please provide environment, pr-number input, or run in a pull_request/push context."
      )
    }

    core.info(`Fetching outputs for ${org}/${repo} environment=${environment} workspace=${workspace}`)

    if (!token) {
      throw new Error("No Yaffle API token provided. Set the token input or YAFFLE_API_TOKEN env var.")
    }

    if (!token.startsWith("yfl_")) {
      throw new Error(
        "Yaffle API token must look like a Better Auth API key (prefix 'yfl_'). "
        + "If loading from Secrets Manager, store the raw key string or JSON with {\"token\":\"yfl_...\"}."
      )
    }

    const snapshot = await fetchEnvironment(apiUrl, token, org, repo, environment, headSha)
    const workspaceDeployment = findWorkspaceDeployment(snapshot, workspace)
    if (!workspaceDeployment) {
      throw new Error(`No workspace deployment found for ${org}/${repo} environment=${environment} workspace=${workspace}`)
    }

    core.info(`Found workspace deployment ${workspaceDeployment.preview.id} with status: ${workspaceDeployment.preview.status}`)
    core.setOutput("preview-id", workspaceDeployment.preview.id)
    core.setOutput("preview-status", workspaceDeployment.preview.status)

    let outputs: Record<string, TerraformOutput> | null = null

    // Wait for workspace deployment to be ready if requested
    if (wait && workspaceDeployment.preview.status !== "ready") {
      core.info(`Waiting for workspace deployment to be ready via SSE (timeout: ${waitTimeout}s)...`)
      let readyWorkspace: EnvironmentWorkspace
      try {
        readyWorkspace = await waitForReadySSE(
          apiUrl,
          token,
          org,
          repo,
          environment,
          headSha,
          workspaceDeployment.preview.id,
          workspace,
          waitTimeout,
        )
      } catch (error) {
        core.warning(`SSE wait failed (${error instanceof Error ? error.message : String(error)}), falling back to polling`)
        readyWorkspace = await waitForReadyPolling(
          apiUrl,
          token,
          org,
          repo,
          environment,
          headSha,
          workspace,
          waitTimeout,
        )
      }
      core.setOutput("preview-status", readyWorkspace.preview.status)
      outputs = readyWorkspace.outputs
    } else if (workspaceDeployment.preview.status === "ready") {
      outputs = workspaceDeployment.outputs
    }

    if (!outputs) {
      core.warning("No outputs found for this workspace deployment")
      core.setOutput("outputs-json", "{}")
      return
    }

    core.setOutput("outputs-json", JSON.stringify(outputs))

    // Set each output as a separate action output
    for (const [name, output] of Object.entries(outputs)) {
      const tfOutput = output as TerraformOutput
      if (tfOutput.sensitive) {
        core.setSecret(String(tfOutput.value))
        core.setOutput(name, tfOutput.value)
      } else {
        const value = typeof tfOutput.value === "object"
          ? JSON.stringify(tfOutput.value)
          : String(tfOutput.value)
        core.setOutput(name, value)
        core.info(`Output ${name} = ${value}`)
      }
    }

    core.info("Successfully fetched all outputs")
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed(String(error))
    }
  }
}

async function fetchEnvironment(
  apiUrl: string,
  token: string,
  org: string,
  repo: string,
  environment: string,
  headSha: string,
): Promise<EnvironmentSnapshot> {
  const query = headSha ? `?head_sha=${encodeURIComponent(headSha)}` : ""
  const url = `${apiUrl}/api/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}/environment/${encodeURIComponent(environment)}${query}`

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  })

  if (response.status === 404) {
    throw new Error(`Environment not found: ${org}/${repo} environment=${environment}`)
  }

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to fetch environment: ${response.status} ${text}`)
  }

  const data = await response.json() as { data: EnvironmentSnapshot }
  return data.data
}

function findWorkspaceDeployment(
  snapshot: EnvironmentSnapshot,
  workspace: string,
): EnvironmentWorkspace | null {
  const targetWorkspace = snapshot.workspaces.find((item) => item.preview.workspacePath === workspace)
  if (!targetWorkspace) {
    return null
  }
  return targetWorkspace
}

async function waitForReadyPolling(
  apiUrl: string,
  token: string,
  org: string,
  repo: string,
  environment: string,
  headSha: string,
  workspace: string,
  timeoutSeconds: number,
): Promise<EnvironmentWorkspace> {
  const timeoutAt = Date.now() + (timeoutSeconds * 1000)
  let lastLoggedStatus: string | null = null

  while (Date.now() < timeoutAt) {
    const snapshot = await fetchEnvironment(apiUrl, token, org, repo, environment, headSha)
    const workspaceDeployment = findWorkspaceDeployment(snapshot, workspace)
    if (!workspaceDeployment) {
      throw new Error(`Workspace deployment not found while waiting: ${org}/${repo} environment=${environment} workspace=${workspace}`)
    }

    if (workspaceDeployment.preview.status !== lastLoggedStatus) {
      lastLoggedStatus = workspaceDeployment.preview.status
      core.info(`Workspace deployment status: ${workspaceDeployment.preview.status}`)
    }

    if (workspaceDeployment.preview.status === "ready") {
      core.info("Workspace deployment is ready!")
      return workspaceDeployment
    }

    if (workspaceDeployment.preview.status === "failed") {
      throw new Error("Workspace deployment failed")
    }

    if (workspaceDeployment.preview.status === "destroyed") {
      throw new Error("Workspace deployment was destroyed")
    }

    await new Promise((resolve) => setTimeout(resolve, 5000))
  }

  throw new Error(`Workspace deployment did not become ready within ${timeoutSeconds}s`)
}

async function waitForReadySSE(
  apiUrl: string,
  token: string,
  org: string,
  repo: string,
  environment: string,
  headSha: string,
  workspaceDeploymentId: string,
  workspace: string,
  timeoutSeconds: number,
): Promise<EnvironmentWorkspace> {
  return await new Promise((resolve, reject) => {
    const timeoutMs = timeoutSeconds * 1000
    const streamQuery = new URLSearchParams({ token })
    if (headSha) {
      streamQuery.set("head_sha", headSha)
    }
    const streamUrl = `${apiUrl}/api/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}/environment/${encodeURIComponent(environment)}/stream?${streamQuery.toString()}`
    core.info(`Connecting to SSE stream: ${apiUrl}/api/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}/environment/${encodeURIComponent(environment)}/stream`)

    const es = new EventSource(streamUrl)
    let settled = false
    let lastLoggedStatus: string | null = null
    const startedAt = Date.now()
    let consecutiveAuthFailures = 0
    let lastSseActivityAt = Date.now()

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(revalidate)
      es.close()
      fn()
    }

    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`Workspace deployment did not become ready within ${timeoutSeconds}s`)))
    }, timeoutMs)

    const revalidate = setInterval(() => {
      if (settled) return

      // Only revalidate if SSE appears stalled. This avoids hammering auth/API
      // while the stream is healthy and actively delivering updates.
      const sseStalledMs = Date.now() - lastSseActivityAt
      if (sseStalledMs < 45000) {
        return
      }

      void (async () => {
        try {
          const snapshot = await fetchEnvironment(apiUrl, token, org, repo, environment, headSha)
          consecutiveAuthFailures = 0
          const workspaceDeployment = findWorkspaceDeployment(snapshot, workspace)

          if (!workspaceDeployment) {
            if (headSha) {
              finish(() => reject(new Error(
                `Workspace deployment disappeared for head_sha=${headSha} (likely superseded by a newer push)`
              )))
              return
            }
            return
          }

          if (workspaceDeployment.preview.status !== lastLoggedStatus) {
            lastLoggedStatus = workspaceDeployment.preview.status
            core.info(`Workspace deployment status: ${workspaceDeployment.preview.status}`)
          }

          if (workspaceDeployment.preview.status === "ready") {
            finish(() => resolve(workspaceDeployment))
            return
          }

          if (workspaceDeployment.preview.status === "failed") {
            finish(() => reject(new Error("Workspace deployment failed")))
            return
          }

          if (workspaceDeployment.preview.status === "destroyed") {
            finish(() => reject(new Error("Workspace deployment was destroyed")))
            return
          }

          const elapsedSec = Math.floor((Date.now() - startedAt) / 1000)
          if (elapsedSec > 0 && elapsedSec % 60 === 0) {
            core.info(`Still waiting... (${elapsedSec}s elapsed)`)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message.includes("Failed to fetch environment: 401")) {
            consecutiveAuthFailures += 1
            if (consecutiveAuthFailures >= 6) {
              finish(() => reject(new Error(
                "Lost API authentication while waiting for deployment status (received repeated 401 responses). "
                + "Check YAFFLE_API_TOKEN validity and control-plane auth health."
              )))
              return
            }
            if (consecutiveAuthFailures === 1) {
              core.warning("Transient auth check failed during SSE wait; retrying")
            }
            return
          }

          core.warning(`SSE revalidation check failed: ${message}`)
        }
      })()
    }, 15000)

    es.addEventListener("update", (event: MessageEvent) => {
      if (settled) return
      lastSseActivityAt = Date.now()
      consecutiveAuthFailures = 0

      try {
        const payload = JSON.parse(event.data) as EnvironmentStreamUpdate
        const workspaces = payload.data?.workspaces || []
        const targetWorkspace = workspaces.find((item) => item.preview.id === workspaceDeploymentId)
          ?? workspaces.find((item) => item.preview.workspacePath === workspace)

        if (!targetWorkspace) {
          return
        }

        if (targetWorkspace.preview.status !== lastLoggedStatus) {
          lastLoggedStatus = targetWorkspace.preview.status
          core.info(`Workspace deployment status: ${targetWorkspace.preview.status}`)
        }

        if (targetWorkspace.preview.status === "ready") {
          finish(() => resolve(targetWorkspace))
          return
        }

        if (targetWorkspace.preview.status === "failed") {
          finish(() => reject(new Error("Workspace deployment failed")))
          return
        }

        if (targetWorkspace.preview.status === "destroyed") {
          finish(() => reject(new Error("Workspace deployment was destroyed")))
        }
      } catch (error) {
        core.warning(`Failed to parse SSE event: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

    es.onerror = () => {
      if (!settled) {
        core.warning("SSE connection error; waiting for reconnect")
      }
    }

    es.addEventListener("heartbeat", () => {
      if (!settled) {
        lastSseActivityAt = Date.now()
        consecutiveAuthFailures = 0
      }
    })

    es.onopen = () => {
      lastSseActivityAt = Date.now()
      core.info("SSE connection established")
    }
  })
}

run()
