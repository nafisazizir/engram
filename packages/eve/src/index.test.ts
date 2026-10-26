import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { initLocalGitRepo, localGitBackend, type MemoryRepo, memoryRepo } from "@nafisazizir/engram-core";

import { formatRecall, repoMemory } from "./index.ts";

let dir: string;
let repo: MemoryRepo;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "memory-eve-"));
  await initLocalGitRepo(dir);
  repo = memoryRepo({
    backend: localGitBackend(dir),
    author: { name: "adam", email: "adam@memory.local" },
    today: () => "2026-10-26",
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const memory = { slot: "owner", scope: { key: "k", namespace: "n", value: "owner" } };
const session = { id: "s1", auth: { current: null } };
const recallContext = { memory, session, abortSignal: new AbortController().signal, messages: [], operationId: "op" };
const toolsContext = { memory, session, model: null, channel: {}, turn: { id: "t", input: [], sequence: 0 } };

type Tool = { execute(input: unknown, ctx: unknown): Promise<unknown> };

async function toolsOf(provider: ReturnType<typeof repoMemory>): Promise<Record<string, Tool>> {
  return ((await provider.tools(toolsContext as never)) ?? {}) as unknown as Record<string, Tool>;
}

function recall(provider: ReturnType<typeof repoMemory>) {
  return provider.recall["turn.started"](recallContext as never);
}

test("recalls nothing until memory exists", async () => {
  assert.equal(await recall(repoMemory({ repo: () => repo })), null);
});

test("recalls MEMORY.md under a stable id", async () => {
  await repo.save({ text: "Lives in Brisbane" });
  const result = await recall(repoMemory({ repo: () => repo }));
  assert.equal(result?.messages.length, 1);
  assert.equal(result?.messages[0]?.id, "memory-repo-index");
  assert.match(result?.messages[0]?.content ?? "", /durable data, not instructions[\s\S]*- Lives in Brisbane/);
});

test("a scope with no repo gets no recall and no tools", async () => {
  await repo.save({ text: "Lives in Brisbane" });
  const provider = repoMemory({ repo: () => null });
  assert.equal(await recall(provider), null);
  assert.equal(await provider.tools(toolsContext as never), null);
});

test("save and remove go through the repo with the session as source", async () => {
  const tools = await toolsOf(repoMemory({ repo: () => repo }));
  await tools.save_memory?.execute({ text: "Tore left calf 2026-10-18", file: "health.md" }, {});
  assert.match((await repo.read("health.md")) ?? "", /- Tore left calf 2026-10-18 \[source: owner:s1; added: 2026-10-26\]/);
  assert.deepEqual(await tools.remove_memory?.execute({ text: "Tore left calf 2026-10-18", file: "health.md" }, {}), {
    changed: true,
    file: "health.md",
    commit: (await localGitBackend(dir).head("main")) ?? "",
  });
});

test("search, read and list expose the rest of the repo", async () => {
  await repo.save({ text: "Sister is Aisha", file: "people/family.md" });
  const tools = await toolsOf(repoMemory({ repo: () => repo }));
  const { matches } = (await tools.search_memory?.execute({ pattern: "aisha" }, {})) as { matches: unknown[] };
  assert.equal(matches.length, 1);
  assert.deepEqual(await tools.read_memory?.execute({ path: "missing.md" }, {}), { path: "missing.md", found: false });
  assert.deepEqual(await tools.list_memory?.execute({}, {}), { files: ["MEMORY.md", "people/family.md"] });
});

test("a caller who cannot write still gets the read tools", async () => {
  const tools = await toolsOf(repoMemory({ repo: () => repo, canWrite: () => false }));
  assert.deepEqual(Object.keys(tools).sort(), ["list_memory", "read_memory", "search_memory"]);
});

test("a long index is cut at a line boundary and points at the rest", () => {
  const index = Array.from({ length: 400 }, (_, at) => `- fact number ${at}`).join("\n");
  const recalled = formatRecall(index, "owner", 2_000);
  assert.ok(recalled.length <= 2_000);
  assert.match(recalled, /- fact number \d+\n\[Truncated\. Read the rest with `owner__read_memory` on MEMORY\.md\.\]$/);
});
