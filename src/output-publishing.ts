export interface TerraformOutput {
  value: unknown
  type?: string
  sensitive: boolean
}

function formatTerraformOutput(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`
  }
  return JSON.stringify(value) ?? ""
}

export function prepareActionOutputs(outputs: Record<string, TerraformOutput>): {
  outputsJson: string
  entries: Array<{ name: string; value: string }>
} {
  const entries: Array<{ name: string; value: string }> = []

  for (const [name, output] of Object.entries(outputs)) {
    if (output.sensitive === true) {
      throw new Error(
        `Cannot publish sensitive Terraform output through the Outputs Action: ${name}. Store the secret in a secret manager and publish only its ARN or identifier.`,
      )
    }
    entries.push({ name, value: formatTerraformOutput(output.value) })
  }

  return {
    outputsJson: JSON.stringify(outputs),
    entries,
  }
}
