import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { initLocalGitRepo, localGitBackend } from "./backends/local-git.ts";
import { cachedBackend } from "./cached.ts";
import { memoryRepo } from "./repo.ts";
import { backendSuite } from "./testing/suite.ts";

const dirs: string[] = [];

async function localRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "engram-"));
  dirs.push(dir);
  await initLocalGitRepo(dir);
  return dir;
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

backendSuite("local git", async () => ({ backend: localGitBackend(await localRepo()), branch: "main" }));

backendSuite("cached local git", async () => ({ backend: cachedBackend(localGitBackend(await localRepo())), branch: "main" }));

test("rejects unsafe paths before touching the backend", async () => {
  const repo = memoryRepo({ backend: localGitBackend(await localRepo()), author: { name: "t", email: "t@t" } });
  await assert.rejects(repo.save({ text: "x", file: "../escape.md" }), TypeError);
  await assert.rejects(repo.read("/etc/hosts.md"), TypeError);
});
