import assert from "node:assert/strict"
import { test } from "node:test"

import { resolveEnvironment } from "./environment"

const context = {
  environment: "",
  prNumber: "",
  pullRequestNumber: 42,
  issueNumber: 43,
  issueIsPullRequest: true,
  ref: "refs/heads/main",
}

void test("explicit environment wins", () => {
  assert.equal(
    resolveEnvironment({ ...context, environment: "staging", prNumber: "41" }),
    "staging",
  )
})

void test("explicit environment does not hide an invalid PR number", () => {
  assert.throws(
    () => resolveEnvironment({ ...context, environment: "staging", prNumber: "41abc" }),
    /Invalid pr-number input: expected a positive safe integer/,
  )
})

void test("valid explicit PR number wins", () => {
  assert.equal(resolveEnvironment({ ...context, prNumber: "41" }), "pr-41")
})

void test("invalid explicit PR number fails closed", () => {
  for (const prNumber of ["0", "41abc", "999999999999999999999"]) {
    assert.throws(
      () => resolveEnvironment({ ...context, prNumber }),
      /Invalid pr-number input: expected a positive safe integer/,
    )
  }
})

void test("pull request context wins over PR issue context", () => {
  assert.equal(resolveEnvironment(context), "pr-42")
})

void test("PR issue context wins over branch context", () => {
  assert.equal(resolveEnvironment({ ...context, pullRequestNumber: undefined }), "pr-43")
})

void test("branch context is the final fallback", () => {
  assert.equal(
    resolveEnvironment({
      ...context,
      pullRequestNumber: undefined,
      issueIsPullRequest: false,
    }),
    "main",
  )
})
