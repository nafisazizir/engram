import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { type MemoryBackend, MemoryConflictError } from "./backend.ts";
import { initLocalGitRepo, localGitBackend } from "./backends/local-git.ts";
import { memoryRepo } from "./repo.ts";

const author = { name: "test-client", email: "test@memory.local" };
const today = () => "2026-10-26";
let dir: string;
let backend: MemoryBackend;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "memory-repo-"));
  await initLocalGitRepo(dir);
  backend = localGitBackend(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("an empty repo has no index, files or matches", async () => {
  const repo = memoryRepo({ backend, author, today });
  assert.equal(await repo.index(), null);
  assert.deepEqual(await repo.list(), []);
  assert.deepEqual(await repo.search("anything"), []);
});

test("the first save creates MEMORY.md with a dated, sourced entry", async () => {
  const repo = memoryRepo({ backend, author, today });
  const result = await repo.save({ text: "Lives in Brisbane", source: "adam:s1" });
  assert.equal(result.changed, true);
  assert.equal(await repo.index(), "# Memory\n\n- Lives in Brisbane [source: adam:s1; added: 2026-10-26]\n");
});

test("saving identical text is a no-op", async () => {
  const repo = memoryRepo({ backend, author, today });
  await repo.save({ text: "Lives in Brisbane" });
  const head = await backend.head("main");
  assert.deepEqual(await repo.save({ text: "  Lives in   Brisbane " }), { changed: false, file: "MEMORY.md" });
  assert.equal(await backend.head("main"), head);
});

test("saving to a new note links it from the index in the same commit", async () => {
  const repo = memoryRepo({ backend, author, today });
  await repo.save({ text: "Lives in Brisbane" });
  await repo.save({ text: "Tore left calf, no running for 3 weeks", file: "health.md" });
  assert.equal(await repo.read("health.md"), "# Health\n\n- Tore left calf, no running for 3 weeks [added: 2026-10-26]\n");
  assert.match((await repo.index()) ?? "", /## Index\n- \[\[health\]\]\n$/);
  assert.deepEqual(await repo.list(), ["MEMORY.md", "health.md"]);
  const parent = `${await backend.head("main")}~1`;
  assert.equal(await backend.readFile("health.md", parent), null);
  assert.doesNotMatch((await backend.readFile("MEMORY.md", parent)) ?? "", /\[\[health\]\]/);
});

test("removing an entry deletes only that line", async () => {
  const repo = memoryRepo({ backend, author, today });
  await repo.save({ text: "A" });
  await repo.save({ text: "B" });
  assert.equal((await repo.remove({ text: "A" })).changed, true);
  assert.equal(await repo.index(), "# Memory\n\n- B [added: 2026-10-26]\n");
  assert.equal((await repo.remove({ text: "A" })).changed, false);
});

test("search matches case-insensitively across files", async () => {
  const repo = memoryRepo({ backend, author, today });
  await repo.save({ text: "Prefers oat milk" });
  await repo.save({ text: "Allergic to peanuts", file: "health.md" });
  const hits = await repo.search("PEANUT|oat");
  assert.deepEqual(
    hits.map((hit) => [hit.path, hit.line]),
    [
      ["MEMORY.md", 3],
      ["health.md", 3],
    ],
  );
  assert.match(hits[1]?.text ?? "", /Allergic to peanuts/);
});

test("concurrent writers each land their entry", async () => {
  const clients = ["adam", "claude-code", "claude-ai", "grokbot", "laptop"].map((name) =>
    memoryRepo({ backend, author: { name, email: `${name}@memory.local` }, today }),
  );
  await clients[0]?.save({ text: "seed" });
  await Promise.all(clients.map((client, at) => client.save({ text: `fact from client ${at}` })));
  const index = (await clients[0]?.index()) ?? "";
  for (let at = 0; at < clients.length; at += 1) assert.match(index, new RegExp(`fact from client ${at}`));
});

test("a write that loses the race retries from the new head", async () => {
  const repo = memoryRepo({ backend, author, today });
  await repo.save({ text: "seed" });
  let raced = false;
  const racing: MemoryBackend = {
    ...backend,
    async commit(change) {
      if (!raced) {
        raced = true;
        await memoryRepo({ backend, author, today }).save({ text: "sneaked in" });
      }
      return backend.commit(change);
    },
  };
  await memoryRepo({ backend: racing, author, today }).save({ text: "mine" });
  const index = (await repo.index()) ?? "";
  assert.match(index, /sneaked in/);
  assert.match(index, /mine/);
});

test("a stale commit is rejected as a conflict", async () => {
  const repo = memoryRepo({ backend, author, today });
  await repo.save({ text: "seed" });
  const stale = await backend.head("main");
  await repo.save({ text: "newer" });
  await assert.rejects(
    backend.commit({ branch: "main", expectedHeadSha: stale, message: "stale", author, put: { "MEMORY.md": "x\n" } }),
    MemoryConflictError,
  );
});

test("creating a branch that already exists is a conflict", async () => {
  await memoryRepo({ backend, author, today }).save({ text: "seed" });
  await assert.rejects(
    backend.commit({ branch: "main", expectedHeadSha: null, message: "dup", author, put: { "MEMORY.md": "x\n" } }),
    MemoryConflictError,
  );
});

test("an inbox writer seeds its branch from main and leaves main untouched", async () => {
  const trusted = memoryRepo({ backend, author, today });
  await trusted.save({ text: "Lives in Brisbane" });
  const mainHead = await backend.head("main");

  const inbox = memoryRepo({ backend, author: { name: "claude-ai", email: "c@memory.local" }, writeBranch: "inbox", today });
  await inbox.save({ text: "Likes spicy food" });
  await inbox.save({ text: "Has a cat" });

  assert.equal(await backend.head("main"), mainHead);
  assert.doesNotMatch((await inbox.index()) ?? "", /spicy/);
  const pending = (await backend.readFile("MEMORY.md", "inbox")) ?? "";
  assert.match(pending, /Lives in Brisbane[\s\S]*Likes spicy food[\s\S]*Has a cat/);
});

test("rejects unsafe paths before touching the backend", async () => {
  const repo = memoryRepo({ backend, author, today });
  await assert.rejects(repo.save({ text: "x", file: "../escape.md" }), TypeError);
  await assert.rejects(repo.read("/etc/hosts.md"), TypeError);
});
