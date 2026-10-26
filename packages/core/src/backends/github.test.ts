import assert from "node:assert/strict";
import { test } from "node:test";

import { memoryRepo } from "../repo.ts";
import { backendSuite } from "../testing/suite.ts";
import { githubBackend } from "./github.ts";

// Runs against a real, disposable repo only when asked:
// ENGRAM_GITHUB_TEST_REPO=owner/name GITHUB_TOKEN=... pnpm test
const target = process.env.ENGRAM_GITHUB_TEST_REPO;
const token = process.env.GITHUB_TOKEN;

if (target && token) {
  const [owner = "", repo = ""] = target.split("/");
  const backend = githubBackend({ owner, repo, token });
  const run = Date.now().toString(36);
  let count = 0;

  test("github: the first commit into an empty repo creates its default branch", async () => {
    if ((await backend.head("main")) !== null) return;
    const memory = memoryRepo({ backend, author: { name: "test-client", email: "t@m.l" } });
    await memory.save({ text: "first fact" });
    assert.match((await memory.index()) ?? "", /- first fact/);
  });

  backendSuite("github", async () => ({ backend, branch: `test-${run}-${(count += 1)}` }));
}
