import assert from "node:assert/strict"
import test from "node:test"

import { prepareActionOutputs } from "./output-publishing.js"

void test("publishes non-sensitive outputs", () => {
  assert.deepEqual(
    prepareActionOutputs({
      endpoint: { value: "https://api.example.test", sensitive: false },
    }),
    {
      outputsJson: '{"endpoint":{"value":"https://api.example.test","sensitive":false}}',
      entries: [{ name: "endpoint", value: "https://api.example.test" }],
    },
  )
})

void test("fails closed if the server selects a sensitive output", () => {
  assert.throws(
    () =>
      prepareActionOutputs({
        password: { value: "do-not-publish", sensitive: true },
      }),
    /Cannot publish sensitive Terraform output.*password.*secret manager/,
  )
})

void test("fails closed for structurally redacted sensitive outputs", () => {
  assert.throws(
    () =>
      prepareActionOutputs({
        password: { value: null, sensitive: true },
      }),
    /Cannot publish sensitive Terraform output.*password.*secret manager/,
  )
})
