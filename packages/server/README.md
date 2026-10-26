# engram server

The only holder of the memory repo's GitHub token. Every client except Adam reaches memory here.

| Route              | For                                                        |
| ------------------ | ---------------------------------------------------------- |
| `/mcp`             | MCP tools: memory_index, search, read, list, save, remove  |
| `/v1/index`        | `MEMORY.md` as text, for a SessionStart hook               |
| `/webhooks/github` | push webhook; drops the cached branch head                 |

Every request carries a per-device key as `Authorization: Bearer <key>`. A key's grant decides which
branch it writes: `main`, `inbox` (reviewed before merging), or nothing.

## Deploy (Vercel)

Import the repo with **Root Directory** `packages/server`; Vercel detects Hono from `src/index.ts`
and runs `vercel-build`, which builds `engram-core` first. Set the variables from `.env.example`. A
missing or malformed one stops the function at startup, and the runtime logs name it.

## Add a device

```sh
pnpm keygen personal-laptop main      # or: work-laptop inbox, grokbot inbox, viewer read-only
```

Append the printed entry to `ENGRAM_CLIENTS` and redeploy. Revoke a device by deleting its entry.

## Claude Code (each laptop, each account)

```sh
claude mcp add --scope user --transport http engram https://<engram>/mcp \
  --header "Authorization: Bearer $ENGRAM_KEY"
```

Guaranteed recall at session start, in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -fsS --max-time 5 -H \"Authorization: Bearer $ENGRAM_KEY\" https://<engram>/v1/index || true"
          }
        ]
      }
    ]
  }
}
```
