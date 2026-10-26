# Deploying the engram server

About 15 minutes. You need: a Vercel account, this repo on GitHub (`nafisazizir/engram`), the empty
private memory repo (`nafisazizir/my-mem`), and this repo cloned locally with `pnpm install` run.

## 1. Make the secrets

There are three kinds. Each one lives in exactly one place: the server's copy goes in Vercel, the
device's copy goes on that device. Never put any of them in a repo, a chat or a ticket.

### 1a. GitHub token: the server's only access to your memory

1. Open <https://github.com/settings/personal-access-tokens/new> (a **fine-grained** token, not a classic
   one).
2. **Token name:** `engram-server`. **Expiration:** 1 year. Put a reminder in your calendar a week
   before it expires.
3. **Resource owner:** `nafisazizir`.
4. **Repository access:** *Only select repositories* → `my-mem`. Nothing else.
5. **Permissions → Repository permissions → Contents:** *Read and write*. Leave everything else on *No
   access*. GitHub adds *Metadata: Read* by itself.
6. **Generate token**, and copy the `github_pat_…` value straight into Vercel in step 2. GitHub won't
   show it again; if you lose it, delete it and make another.

Even if this token leaked, it would only give access to `my-mem`'s files: no other repo, no account
settings.

### 1b. Device keys: one per client that connects

Run these in your own terminal, not in an AI chat, so the keys never end up in a transcript:

```sh
cd ~/Documents/personal/engram/packages/server
pnpm keygen personal-laptop main
pnpm keygen work-laptop main
```

Each run prints two things:

- **The key** (`engram_…`). It's shown once. Save it in your password manager as "engram key:
  personal-laptop". It goes on that device later; the server never stores it.
- **The entry** (`{"name":…,"keySha256":…,"writeBranch":…}`), which holds only a hash of the key. This
  is what the server stores.

Put the entries into one JSON array on one line. That is the value of `ENGRAM_CLIENTS`:

```json
[{"name":"personal-laptop","keySha256":"…","writeBranch":"main"},{"name":"work-laptop","keySha256":"…","writeBranch":"main"}]
```

`writeBranch` decides where a client's saves go: `"main"` (live for everyone), `"inbox"` (held until
reviewed; the review isn't built yet, so use it only for clients you want held back), or `null`
(read-only).

**Not ready to connect anything yet?** Use `ENGRAM_CLIENTS=[]`. The server deploys, and every request
except `/health` is refused, because there are no keys. Add clients later.

### 1c. Webhook secret (optional)

```sh
openssl rand -hex 32
```

With it, edits you make to `my-mem` outside engram (on github.com, or by pushing from a clone) show up
immediately. Without it, they show up within about 10 seconds anyway. Keep the value for steps 2 and 4.

## 2. Create the Vercel project

1. <https://vercel.com/new> → import `nafisazizir/engram`.
2. **Root Directory:** click *Edit* and choose `packages/server`. This matters: the repo is a monorepo,
   and the server lives there.
3. **Framework Preset:** Vercel should pick **Hono** on its own. Leave the build and install commands as
   they are. The server's `vercel-build` script builds `engram-core` first.
4. **Environment Variables** (paste values with no surrounding quotes):

   | Name | Value |
   | ---- | ----- |
   | `GITHUB_TOKEN` | the `github_pat_…` from 1a |
   | `MEMORY_REPO` | `nafisazizir/my-mem` |
   | `ENGRAM_CLIENTS` | the one-line JSON array from 1b, or `[]` |
   | `GITHUB_WEBHOOK_SECRET` | the hex string from 1c (optional) |

5. **Deploy.** Your URL will be something like `https://engram-<something>.vercel.app`. Below it's
   written as `$ENGRAM`.

To change a variable later: Project → Settings → Environment Variables, edit it, then Deployments →
the latest one → ⋯ → **Redeploy**. Variables only take effect on a new deployment.

## 3. Check it works

```sh
ENGRAM=https://engram-<something>.vercel.app
KEY=engram_…   # the personal-laptop key, pasted here only for this check

curl -s $ENGRAM/health                                        # ok
curl -s -o /dev/null -w "%{http_code}\n" $ENGRAM/v1/index     # 401: no key, refused
curl -s -H "Authorization: Bearer $KEY" $ENGRAM/v1/index      # "# Engram memory (MEMORY.md)" … "Memory is empty."
```

If the second line prints `401` and the third shows the memory header, the server, the GitHub token
and the key all work. (With `ENGRAM_CLIENTS=[]` the third check also returns 401. That's expected.)

## 4. Add the webhook (if you made a secret)

On `my-mem`: **Settings → Webhooks → Add webhook**

- **Payload URL:** `$ENGRAM/webhooks/github`
- **Content type:** `application/json`
- **Secret:** the same hex string as `GITHUB_WEBHOOK_SECRET`
- **Which events:** *Just the push event*

GitHub sends a ping when you save it. A green tick under *Recent Deliveries* means it arrived.

## 5. Connect a laptop (later)

Covered in [`packages/server/README.md`](../packages/server/README.md): one `claude mcp add` per laptop
and account, plus the SessionStart hook. The laptop uses its own device key from 1b.

## Is it safe?

Once deployed, the server is a **public URL**: anyone can send it requests. Here is what protects it:

| Who | What they can do |
| --- | ---------------- |
| Anyone without a key | Only `/health`, which says `ok`. Every other route returns 401. Keys are 256-bit random values compared by hash, so guessing one isn't possible. |
| Someone who forges a webhook | Nothing. A push without the right HMAC signature is refused, and even a valid one only clears a cache. |
| A client with a key | Reads all of memory; writes only to its `writeBranch`. |
| Vercel | Holds the GitHub token, which only reaches `my-mem`. |

The code being public doesn't weaken any of this: the security comes from the secrets, not from
hiding how it works.

What to watch for:

- **A device key is effectively your memory's password.** Anyone holding it can read everything.
  Keep it in your password manager and in that device's config, nowhere else.
- **If a key leaks:** delete its entry from `ENGRAM_CLIENTS` and redeploy. That key stops working
  immediately; the others are unaffected. Make a new one with `pnpm keygen`.
- **If the GitHub token leaks:** delete it at <https://github.com/settings/personal-access-tokens>,
  make a new one (1a), update `GITHUB_TOKEN`, redeploy. Check `my-mem`'s commit history for anything
  you didn't write.
- **Rotate the GitHub token yearly**, when the calendar reminder fires.

## Troubleshooting

- **Every request fails with 500:** a variable is missing or malformed. Project → Logs shows
  `Invalid engram configuration` and names it. The usual suspect is `ENGRAM_CLIENTS` that isn't valid
  JSON, or has quotes around it.
- **401 with a key you're sure is right:** check that its entry is in `ENGRAM_CLIENTS`, that you
  redeployed after adding it, and that the header is exactly `Authorization: Bearer engram_…`.
- **The build fails:** check that Root Directory is `packages/server`, then send the build log to
  whoever is working on engram.
- **`/v1/index` errors with 404 or 403 from GitHub:** the token can't see `my-mem`. Recheck 1a, steps
  3 to 5.
