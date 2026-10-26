import assert from "node:assert/strict";
import { test } from "node:test";

import { type MemoryBackend, MemoryConflictError } from "../backend.ts";
import { memoryRepo } from "../repo.ts";

export interface Fixture {
  backend: MemoryBackend;
  branch: string;
}

const author = { name: "test-client", email: "test@memory.local" };
const today = () => "2026-10-26";

export function backendSuite(name: string, fresh: () => Promise<Fixture>): void {
  const setup = async () => {
    const { backend, branch } = await fresh();
    return { backend, branch, repo: memoryRepo({ backend, author, branch, today }) };
  };

  test(`${name}: an empty branch has no index, files or matches`, async () => {
    const { repo } = await setup();
    assert.equal(await repo.index(), null);
    assert.deepEqual(await repo.list(), []);
    assert.deepEqual(await repo.search("anything"), []);
  });

  test(`${name}: the first save creates MEMORY.md with a dated, sourced entry`, async () => {
    const { repo } = await setup();
    assert.equal((await repo.save({ text: "Lives in Brisbane", source: "adam:s1" })).changed, true);
    assert.equal(await repo.index(), "# Memory\n\n- Lives in Brisbane [source: adam:s1; added: 2026-10-26]\n");
  });

  test(`${name}: saving identical text is a no-op`, async () => {
    const { backend, branch, repo } = await setup();
    await repo.save({ text: "Lives in Brisbane" });
    const head = await backend.head(branch);
    assert.deepEqual(await repo.save({ text: "  Lives in   Brisbane " }), { changed: false, file: "MEMORY.md" });
    assert.equal(await backend.head(branch), head);
  });

  test(`${name}: saving to a new note links it from the index in the same commit`, async () => {
    const { backend, branch, repo } = await setup();
    await repo.save({ text: "Lives in Brisbane" });
    const before = await backend.head(branch);
    await repo.save({ text: "Tore left calf, no running for 3 weeks", file: "health.md" });
    assert.equal(await repo.read("health.md"), "# Health\n\n- Tore left calf, no running for 3 weeks [added: 2026-10-26]\n");
    assert.match((await repo.index()) ?? "", /## Index\n- \[\[health\]\]\n$/);
    assert.deepEqual(await repo.list(), ["MEMORY.md", "health.md"]);
    assert.ok(before);
    assert.equal(await backend.readFile("health.md", before), null);
    assert.doesNotMatch((await backend.readFile("MEMORY.md", before)) ?? "", /\[\[health\]\]/);
  });

  test(`${name}: removing an entry deletes only that line`, async () => {
    const { repo } = await setup();
    await repo.save({ text: "A" });
    await repo.save({ text: "B" });
    assert.equal((await repo.remove({ text: "A" })).changed, true);
    assert.equal(await repo.index(), "# Memory\n\n- B [added: 2026-10-26]\n");
    assert.equal((await repo.remove({ text: "A" })).changed, false);
  });

  test(`${name}: search matches case-insensitively across files`, async () => {
    const { repo } = await setup();
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

  test(`${name}: concurrent writers each land their entry`, async () => {
    const { backend, branch, repo } = await setup();
    await repo.save({ text: "seed" });
    const clients = ["adam", "claude-code", "claude-ai", "grokbot"].map((client) =>
      memoryRepo({ backend, branch, author: { name: client, email: `${client}@memory.local` }, today }),
    );
    await Promise.all(clients.map((client, at) => client.save({ text: `fact from client ${at}` })));
    const index = (await repo.index()) ?? "";
    for (let at = 0; at < clients.length; at += 1) assert.match(index, new RegExp(`fact from client ${at}`));
  });

  test(`${name}: a write that loses the race retries from the new head`, async () => {
    const { backend, branch, repo } = await setup();
    await repo.save({ text: "seed" });
    let raced = false;
    const racing: MemoryBackend = {
      ...backend,
      async commit(change) {
        if (!raced) {
          raced = true;
          await repo.save({ text: "sneaked in" });
        }
        return backend.commit(change);
      },
    };
    await memoryRepo({ backend: racing, branch, author, today }).save({ text: "mine" });
    const index = (await repo.index()) ?? "";
    assert.match(index, /sneaked in/);
    assert.match(index, /mine/);
  });

  test(`${name}: a stale commit is rejected as a conflict`, async () => {
    const { backend, branch, repo } = await setup();
    await repo.save({ text: "seed" });
    const stale = await backend.head(branch);
    await repo.save({ text: "newer" });
    await assert.rejects(
      backend.commit({ branch, expectedHeadSha: stale, message: "stale", author, put: { "MEMORY.md": "x\n" } }),
      MemoryConflictError,
    );
  });

  test(`${name}: creating a branch that already exists is a conflict`, async () => {
    const { backend, branch, repo } = await setup();
    await repo.save({ text: "seed" });
    await assert.rejects(
      backend.commit({ branch, expectedHeadSha: null, message: "dup", author, put: { "MEMORY.md": "x\n" } }),
      MemoryConflictError,
    );
  });

  test(`${name}: an inbox writer seeds its branch and leaves the read branch untouched`, async () => {
    const { backend, branch, repo } = await setup();
    await repo.save({ text: "Lives in Brisbane" });
    const readHead = await backend.head(branch);
    const inboxBranch = `${branch}-inbox`;
    const inbox = memoryRepo({ backend, branch, writeBranch: inboxBranch, author: { name: "claude-ai", email: "c@m.l" }, today });
    await inbox.save({ text: "Likes spicy food" });
    await inbox.save({ text: "Has a cat" });

    assert.equal(await backend.head(branch), readHead);
    assert.doesNotMatch((await inbox.index()) ?? "", /spicy/);
    const pending = (await backend.readFile("MEMORY.md", inboxBranch)) ?? "";
    assert.match(pending, /Lives in Brisbane[\s\S]*Likes spicy food[\s\S]*Has a cat/);
  });
}
