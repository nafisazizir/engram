# Engram

One memory for every agent I use — Adam, Claude Code (work and personal laptops), claude.ai, Grokbot,
and whatever comes next — instead of a separate silo inside each product.

Two repos:

- **`engram`** (this one): the engine. Code only; no memory is ever stored here.
- **`my-mem`**: the memory itself, a private GitHub repo in Agent Memory Repo format.

An engram is the physical trace a memory leaves in the brain; this engine writes those traces.

## Decisions

- **Format: [Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo).** Memory is a git
  repo of markdown. `MEMORY.md` is the entry point every session loads; it stays short and links to
  the rest with `[[path]]`. Each fact is one bullet line with optional trailing metadata,
  `- fact [source: <session>; added: YYYY-MM-DD]`. Any agent that follows the spec can use the repo
  directly, so the format, not this codebase, is the product.
- **Storage: a private GitHub repo.** Free, browsable on the web and phone, and backed up by being git.
  A memory repo is kilobytes, so Code Storage's scale buys nothing; GitHub's API covers what the
  engine needs: raw file reads, one GraphQL query for every file at a commit, and
  `createCommitOnBranch`, which commits several files atomically against an `expectedHeadOid`. The
  backend is one interface in `core`, so Code Storage or anything else is a drop-in swap.
- **Writes are compare-and-swap.** Every write reads at the branch head, commits only if the head has
  not moved, and retries from the new head on conflict, up to 8 times.
- **Everything at a commit is immutable, so it is cached forever by SHA.** Only a branch's head moves;
  it is cached briefly, refreshed by our own writes and by GitHub's push webhook. Recall usually costs
  no GitHub call.
- **One server holds the only GitHub token.** Every client except Adam reaches memory through the
  engram server over MCP: chat apps, and laptops too, because a laptop's `gh` accounts are mixed and a
  token on disk cannot be limited to a branch. Clients authenticate to engram, never GitHub, with a
  per-device key that can be revoked alone. Adam runs server-side and uses the eve adapter directly.
- **Every client is an identity with a grant**: which branch it writes. Trusted clients write `main`;
  clients that read untrusted content, and the work laptop, write `inbox`. The server enforces it.
  Commits carry an `Engram-Client` trailer, and entries a `source`, recording who wrote what.
- **Ours is the only source of truth.** Providers' built-in memories are replaced where possible and
  otherwise treated as an inbox that flows one way into this repo. Never dual-write.
- **One repo for all of life; work lives under `work/`.** Work and personal facts link to each other and
  one search covers both.

## Architecture

```
packages/core     the spec's operations over a git backend
                  index · read · list · search · save · remove
                  backends: GitHub, local bare git (tests, offline), Code Storage
                  cachedBackend: SHA-keyed cache over any backend
packages/eve      eve memory provider: recall MEMORY.md each turn, memory tools  → Adam
packages/server   the engram server (Vercel)
                  /mcp              MCP tools for every client; device keys as bearer tokens
                  /v1/index         MEMORY.md for a SessionStart hook: guaranteed recall
                  /webhooks/github  push webhook: drop the cached head
```

Laptop setup is one command per machine and account, plus a SessionStart hook that curls `/v1/index`
so recall never depends on the model choosing to call a tool.

Not built yet: OAuth for claude.ai and ChatGPT (device keys cover laptops and Grokbot), the nightly
GitHub Action that opens a pull request from `inbox` and tidies `main`, per-client folder visibility,
the import of existing memories.

## Core semantics

- `index()` reads `MEMORY.md` on the read branch.
- `save({ text, file?, source? })` appends one entry (default file `MEMORY.md`). Entries in
  `MEMORY.md` sit above `## Index`. Saving to a new file also links it from the index in the same
  commit. Saving identical text is a no-op.
- `remove({ text, file? })` deletes the entry whose text matches.
- An `inbox` writer (write branch differs from read branch) creates its branch from the read branch on
  its first write and commits there after. It still reads the read branch, so its own pending entries
  are invisible to it until review merges them.
