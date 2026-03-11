import * as core from "@actions/core"
import * as github from "@actions/github"
import { EventSource } from "eventsource"

interface Preview {
  id: string
  status: string
  repo: string
  prNumber: number
  workspacePath: string
}

interface TerraformOutput {
  value: unknown
  type?: string
  sensitive?: boolean
}

interface StreamUpdate {
  preview: Preview | null
  runs: unknown[]
  outputs: Record<string, TerraformOutput> | null
}

async function run(): Promise<void> {
  try {
    const apiUrl = core.getInput("api-url")
    const token = core.getInput("token")
    const workspace = core.getInput("workspace") || "."
    const wait = core.getInput("wait") === "true"
    const waitTimeout = parseInt(core.getInput("wait-timeout") || "300", 10)

    // Determine org, repo, and PR number
    const context = github.context
    const org = core.getInput("org") || context.repo.owner
    const repo = core.getInput("repo") || context.repo.repo
    let prNumber = parseInt(core.getInput("pr-number") || "0", 10)

    // Try to get PR number from context if not provided
    if (!prNumber) {
      if (context.payload.pull_request) {
        prNumber = context.payload.pull_request.number
      } else if (context.payload.issue?.pull_request) {
        prNumber = context.payload.issue.number
      }
    }

    if (!prNumber) {
      throw new Error(
        "Could not determine PR number. Please provide pr-number input or run in a pull_request context."
      )
    }

    core.info(`Fetching outputs for ${org}/${repo}#${prNumber} workspace=${workspace}`)

    // Find the preview
    const preview = await findPreview(apiUrl, token, org, repo, prNumber, workspace)

    if (!preview) {
      throw new Error(`No preview found for ${org}/${repo}#${prNumber} workspace=${workspace}`)
    }

    core.info(`Found preview ${preview.id} with status: ${preview.status}`)
    core.setOutput("preview-id", preview.id)
    core.setOutput("preview-status", preview.status)

    let outputs: Record<string, TerraformOutput> | null = null

    // Wait for preview to be ready if requested
    if (wait && preview.status !== "ready") {
      core.info(`Waiting for preview to be ready via SSE (timeout: ${waitTimeout}s)...`)
      const result = await waitForReadySSE(apiUrl, token, preview.id, waitTimeout)
      core.setOutput("preview-status", result.preview?.status ?? "unknown")
      outputs = result.outputs
    } else if (preview.status === "ready") {
      // Already ready, just fetch outputs
      outputs = await fetchOutputs(apiUrl, token, preview.id)
    }

    if (!outputs) {
      core.warning("No outputs found for this preview")
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

async function findPreview(
  apiUrl: string,
  token: string,
  org: string,
  repo: string,
  prNumber: number,
  workspace: string
): Promise<Preview | null> {
  const url = `${apiUrl}/api/previews?org=${encodeURIComponent(org)}&repo=${encodeURIComponent(repo)}&pr_number=${prNumber}`

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to list previews: ${response.status} ${text}`)
  }

  const data = await response.json() as { data: Preview[] }
  const previews = data.data || []

  // Find the preview matching the workspace
  const preview = previews.find((p) => p.workspacePath === workspace)
  return preview || null
}

async function fetchOutputs(
  apiUrl: string,
  token: string,
  previewId: string
): Promise<Record<string, TerraformOutput> | null> {
  const url = `${apiUrl}/api/previews/${previewId}/outputs`

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to fetch outputs: ${response.status} ${text}`)
  }

  const data = await response.json() as { data: Record<string, TerraformOutput> }
  return data.data
}

/**
 * Wait for preview to be ready using Server-Sent Events.
 */
async function waitForReadySSE(
  apiUrl: string,
  token: string,
  previewId: string,
  timeoutSeconds: number
): Promise<StreamUpdate> {
  return new Promise((resolve, reject) => {
    const timeoutMs = timeoutSeconds * 1000
    const url = `${apiUrl}/api/previews/${previewId}/stream?token=${encodeURIComponent(token)}`

    core.info(`Connecting to SSE stream: ${apiUrl}/api/previews/${previewId}/stream`)

    const es = new EventSource(url)
    let resolved = false

    // Timeout handler
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        es.close()
        reject(new Error(`Preview did not become ready within ${timeoutSeconds}s`))
      }
    }, timeoutMs)

    // Handle incoming updates
    es.addEventListener("update", (event: MessageEvent) => {
      if (resolved) return

      try {
        const data = JSON.parse(event.data) as StreamUpdate

        if (!data.preview) {
          core.warning("Received update with no preview data")
          return
        }

        core.info(`SSE update: status=${data.preview.status}`)

        // Check for terminal states
        if (data.preview.status === "ready") {
          resolved = true
          clearTimeout(timeout)
          es.close()
          core.info("Preview is ready!")
          resolve(data)
        } else if (data.preview.status === "failed") {
          resolved = true
          clearTimeout(timeout)
          es.close()
          reject(new Error("Preview failed"))
        } else if (data.preview.status === "destroyed") {
          resolved = true
          clearTimeout(timeout)
          es.close()
          reject(new Error("Preview was destroyed"))
        }
        // Otherwise keep waiting for the next update
      } catch (err) {
        core.warning(`Failed to parse SSE event: ${err}`)
      }
    })

    // Handle connection errors
    es.onerror = (err: Event) => {
      if (resolved) return

      core.warning(`SSE connection error: ${err.type}`)

      setTimeout(() => {
        if (!resolved && es.readyState === 2) {
          resolved = true
          clearTimeout(timeout)
          reject(new Error("SSE connection closed unexpectedly"))
        }
      }, 5000)
    }

    es.onopen = () => {
      core.info("SSE connection established, waiting for updates...")
    }
  })
}

run()
