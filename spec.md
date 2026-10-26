# Engram

One memory for every agent I use — Adam, Claude Code (work and personal), claude.ai, Grokbot, and
whatever comes next — instead of a separate silo inside each product.

Two repos:

- **`engram`** (this one): the engine. Code only; no memory is ever stored here.
- **`my-mem`**: the memory itself, a Code Storage repo in Agent Memory Repo format. Shell agents keep a
  clone at `~/.memory/my-mem`.

An engram is the physical trace a memory leaves in the brain; this engine writes those traces.

## Decisions

- **Format: [Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo).** Memory is a git
  repo of markdown. `MEMORY.md` is the entry point every session loads; it stays short and links to
  the rest with `[[path]]`. Each fact is one bullet line with optional trailing metadata,
  `- fact [source: <session>; added: YYYY-MM-DD]`. Any agent that follows the spec can use the repo
  directly, so the format, not this codebase, is the product.
- **Storage: [Code Storage](https://code.storage) (Pierre).** Git hosting with an HTTP API: read, list
  and grep at any ref, and commit without a clone. Clients without a filesystem never need a sandbox.
- **Writes are compare-and-swap.** Every write reads at the branch head, commits with
  `expectedHeadSha`, and retries from the new head on conflict. Concurrent agents never overwrite each
  other.
- **Ours is the only source of truth.** Providers' built-in memories are replaced where possible
  (file-based coding agents) and otherwise treated as an inbox that flows one way into this repo.
  Never dual-write.
- **Every client is an identity with a grant**: which branch it writes and, optionally, which folders
  it may see. Trusted clients write `main`; clients that read untrusted content write `inbox`, which a
  review pass merges. The commit author records which client wrote what.
- **One repo for all of life; work lives under `work/`.** Work and personal facts link to each other and
  one search covers both. The top-level folder is the domain, so filtering is a path prefix that
  grep, listing and sparse checkout already support. Code Storage tokens are per repo, so a raw clone
  always sees everything; folder restrictions are enforced by `core` and the MCP server, not storage.

## Architecture

```
packages/core   the spec's operations over a git backend
                index · read · list · search · save · remove
                backends: Code Storage (production), local bare git (tests, offline)
packages/eve    eve memory provider: recall MEMORY.md each turn, memory tools
```

Planned adapters, each a thin layer over `core`:

| Adapter      | For                                                  |
| ------------ | ---------------------------------------------------- |
| `eve`        | Adam, and any other eve agent                        |
| `mcp`        | claude.ai, Grokbot, any MCP client without a shell   |
| `cli` + hooks| Claude Code: pull on session start, push on end      |

Not built yet: the token broker (short-lived, ref-restricted Code Storage JWTs per client), the MCP
server, the CLI, the nightly review that merges `inbox` and prunes stale entries.

## Core semantics

- `index()` reads `MEMORY.md` on the read branch.
- `save({ text, file?, source? })` appends one entry (default file `MEMORY.md`). Entries in
  `MEMORY.md` sit above `## Index`. Saving to a new file also links it from the index in the same
  commit. Saving identical text is a no-op.
- `remove({ text, file? })` deletes the entry whose text matches.
- An `inbox` writer (write branch differs from read branch) creates its branch from the read branch on
  its first write and commits there after. It still reads the read branch, so its own pending entries
  are invisible to it until review merges them.
- Writes retry up to 8 times on conflict before giving up.
