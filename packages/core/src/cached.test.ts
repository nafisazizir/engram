import assert from "node:assert/strict";
import { test } from "node:test";

import { type MemoryBackend, MemoryConflictError } from "./backend.ts";
import { cachedBackend } from "./cached.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

function countingBackend(state: { head: string | null }) {
  const calls: string[] = [];
  const backend: MemoryBackend = {
    async head(branch) {
      calls.push(`head:${branch}`);
      return state.head;
    },
    async readFile(path, ref) {
      calls.push(`read:${path}@${ref}`);
      return `${path} at ${ref}`;
    },
    async listFiles(ref) {
      calls.push(`list@${ref}`);
      return ["MEMORY.md"];
    },
    async grep(pattern, ref) {
      calls.push(`grep:${pattern}@${ref}`);
      return [];
    },
    async commit(change) {
      calls.push(`commit:${change.branch}`);
      if (change.expectedHeadSha !== state.head) throw new MemoryConflictError("moved");
      state.head = B;
      return B;
    },
  };
  return { backend, calls };
}

test("reads through a branch resolve to its head and are cached by commit", async () => {
  const { backend, calls } = countingBackend({ head: A });
  const cached = cachedBackend(backend);
  assert.equal(await cached.readFile("MEMORY.md", "main"), `MEMORY.md at ${A}`);
  assert.equal(await cached.readFile("MEMORY.md", "main"), `MEMORY.md at ${A}`);
  await cached.listFiles("main");
  await cached.listFiles(A);
  assert.deepEqual(calls, ["head:main", `read:MEMORY.md@${A}`, `list@${A}`]);
});

test("a head is trusted until its ttl runs out", async () => {
  let clock = 0;
  const state = { head: A as string | null };
  const { backend, calls } = countingBackend(state);
  const cached = cachedBackend(backend, { headTtlMs: 1_000, now: () => clock });
  await cached.head("main");
  state.head = B;
  clock = 999;
  assert.equal(await cached.head("main"), A);
  clock = 1_000;
  assert.equal(await cached.head("main"), B);
  assert.equal(calls.filter((call) => call === "head:main").length, 2);
});

test("our own commit moves the cached head without asking", async () => {
  const { backend, calls } = countingBackend({ head: A });
  const cached = cachedBackend(backend);
  await cached.commit({ branch: "main", expectedHeadSha: A, message: "m", author: { name: "a", email: "a" }, put: {} });
  assert.equal(await cached.head("main"), B);
  assert.ok(!calls.includes("head:main"));
});

test("a conflict and forgetHeads both drop the cached head", async () => {
  const state = { head: A as string | null };
  const { backend, calls } = countingBackend(state);
  const cached = cachedBackend(backend);
  await cached.head("main");
  state.head = B;
  await assert.rejects(
    cached.commit({ branch: "main", expectedHeadSha: A, message: "m", author: { name: "a", email: "a" }, put: {} }),
    MemoryConflictError,
  );
  assert.equal(await cached.head("main"), B);
  cached.forgetHeads();
  await cached.head("main");
  assert.equal(calls.filter((call) => call === "head:main").length, 3);
});

test("a missing branch reads as empty without touching file storage", async () => {
  const { backend, calls } = countingBackend({ head: null });
  const cached = cachedBackend(backend);
  assert.equal(await cached.readFile("MEMORY.md", "main"), null);
  assert.deepEqual(await cached.listFiles("main"), []);
  assert.deepEqual(calls, ["head:main"]);
});
