# Yaffle Outputs Action

Fetch Terraform outputs from a Yaffle environment for use in CI/CD pipelines. Works with both PR previews (transient environments) and named environments (like `main`).

## How it works

When you set `wait: true`, the action uses **Server-Sent Events (SSE)** to efficiently wait for your preview to become ready. Instead of polling the API every few seconds, it opens a persistent connection and waits for real-time status updates from Yaffle.

This means:
- **Instant response** - as soon as your preview is ready, the action continues
- **No wasted API calls** - the connection just hangs until there's news
- **Efficient** - almost zero CPU/network usage while waiting

## Usage

```yaml
- uses: yaffle-dot-dev/outputs-action@v1
  id: infra
  with:
    # Optional: defaults to current PR
    pr-number: ${{ github.event.pull_request.number }}
    # Optional: defaults to "."
    workspace: infra
    # Optional: wait for preview to be ready
    wait: true
    wait-timeout: 300

- name: Deploy using Terraform outputs
  run: |
    echo "Cluster ARN: ${{ steps.infra.outputs.cluster_arn }}"
    echo "ALB DNS: ${{ steps.infra.outputs.alb_dns }}"
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `api-url` | Yaffle API base URL (no trailing `/api`) | No | `https://api.yaffle.dev` |
| `org` | Organization/owner name | No | Repository owner |
| `repo` | Repository name | No | Current repository |
| `environment` | Environment name (e.g., `main`, `prvw-42`) | No | Auto-detected |
| `pr-number` | PR number (sets environment to `prvw-{n}`) | No | Current PR |
| `workspace` | Workspace path | No | `.` |
| `token` | GitHub token for authentication | No | `${{ github.token }}` |
| `wait` | Wait for preview to be ready | No | `false` |
| `wait-timeout` | Timeout in seconds when waiting | No | `300` |

The environment is automatically detected from:
1. Explicit `environment` input
2. `pr-number` input (becomes `prvw-{n}`)
3. PR context from `pull_request` events
4. Branch name from `push` events (e.g., `refs/heads/main` → `main`)

## Outputs

| Output | Description |
|--------|-------------|
| `preview-id` | The Yaffle preview ID |
| `preview-status` | The preview status |
| `outputs-json` | All outputs as a JSON string |
| `<output-name>` | Each Terraform output is set as a separate output |

## Examples

### Basic usage (current PR)

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: yaffle-dot-dev/outputs-action@v1
        id: infra

      - run: echo "ECS Cluster: ${{ steps.infra.outputs.cluster_arn }}"
```

### Wait for infrastructure to be ready

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: yaffle-dot-dev/outputs-action@v1
        id: infra
        with:
          wait: true
          wait-timeout: 600  # 10 minutes

      - run: |
          aws ecs update-service \
            --cluster ${{ steps.infra.outputs.cluster_arn }} \
            --service my-app \
            --force-new-deployment
```

### Multiple workspaces

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: yaffle-dot-dev/outputs-action@v1
        id: network
        with:
          workspace: infra/network

      - uses: yaffle-dot-dev/outputs-action@v1
        id: compute
        with:
          workspace: infra/compute

      - run: |
          echo "VPC: ${{ steps.network.outputs.vpc_id }}"
          echo "Cluster: ${{ steps.compute.outputs.cluster_arn }}"
```

### Using outputs-json for complex values

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: yaffle-dot-dev/outputs-action@v1
        id: infra

      - run: |
          echo '${{ steps.infra.outputs.outputs-json }}' | jq '.tags.value'
```

### Production deploy (main branch)

```yaml
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: yaffle-dot-dev/outputs-action@v1
        id: infra
        with:
          wait: true
          # Environment auto-detected as 'main' from push event

      - run: echo "Deploying to ${{ steps.infra.outputs.site_url }}"
```
