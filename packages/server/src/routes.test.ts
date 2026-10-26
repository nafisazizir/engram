import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { type CachedBackend, cachedBackend, initLocalGitRepo, localGitBackend } from "@nafisazizir/engram-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { type ClientConfig, hashKey } from "./clients.js";
import { loadConfig } from "./config.js";
import { createApp } from "./routes.js";

const keys = { laptop: "key-laptop", chat: "key-chat", viewer: "key-viewer" };
const clients: ClientConfig[] = [
  { name: "personal-laptop", keySha256: hashKey(keys.laptop), writeBranch: "main" },
  { name: "claude-ai", keySha256: hashKey(keys.chat), writeBranch: "inbox" },
  { name: "viewer", keySha256: hashKey(keys.viewer), writeBranch: null },
];
const webhookSecret = "a-webhook-secret-of-16+";

let dir: string;
let backend: CachedBackend;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "engram-server-"));
  await initLocalGitRepo(dir);
  backend = cachedBackend(localGitBackend(dir), { headTtlMs: 60_000 });
  app = createApp({ backend, clients, readBranch: "main", webhookSecret, today: () => "2026-10-26" });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function connect(key: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://engram.test/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
    fetch: async (url, init) => app.request(String(url), init),
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = result.content.map((part) => part.text).join("\n");
  if (result.isError) throw new Error(text);
  return text;
}

test("rejects requests without a known device key", async () => {
  assert.equal((await app.request("/mcp", { method: "POST" })).status, 401);
  const wrong = await app.request("/v1/index", { headers: { authorization: "Bearer nope" } });
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get("www-authenticate") ?? "", /Bearer/);
  assert.equal((await app.request("/health")).status, 200);
});

test("a trusted client saves to main and every client then sees it", async () => {
  const laptop = await connect(keys.laptop);
  assert.equal(await call(laptop, "memory_index"), "Memory is empty.");
  assert.equal(await call(laptop, "memory_save", { text: "Lives in Brisbane" }), "Saved to MEMORY.md.");
  assert.equal(await call(laptop, "memory_save", { text: "Shipped the billing revamp", file: "work/avenue2/projects.md" }), "Saved to work/avenue2/projects.md.");

  const viewer = await connect(keys.viewer);
  assert.match(await call(viewer, "memory_index"), /- Lives in Brisbane \[source: engram:personal-laptop; added: 2026-10-26\]/);
  assert.equal(await call(viewer, "memory_search", { pattern: "billing" }), "work/avenue2/projects.md:3: - Shipped the billing revamp [source: engram:personal-laptop; added: 2026-10-26]");
  assert.equal(await call(viewer, "memory_list"), "MEMORY.md\nwork/avenue2/projects.md");
  assert.match(await call(viewer, "memory_read", { path: "work/avenue2/projects.md" }), /^# Projects/);
});

test("an inbox client's writes wait on the inbox branch", async () => {
  await call(await connect(keys.laptop), "memory_save", { text: "Lives in Brisbane" });
  const chat = await connect(keys.chat);
  assert.equal(await call(chat, "memory_save", { text: "Likes spicy food" }), "Saved to MEMORY.md. It is pending review before other sessions see it.");
  assert.doesNotMatch(await call(chat, "memory_index"), /spicy/);
  assert.match((await backend.readFile("MEMORY.md", "inbox")) ?? "", /Likes spicy food \[source: engram:claude-ai/);
});

test("a read-only client gets no write tools", async () => {
  const { tools } = await (await connect(keys.viewer)).listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["memory_index", "memory_list", "memory_read", "memory_search"]);
});

test("tells clients when to use memory", async () => {
  const client = await connect(keys.laptop);
  assert.match(client.getInstructions() ?? "", /At the start of every conversation, call memory_index/);
});

test("an unsafe path comes back as a tool error, not a crash", async () => {
  await assert.rejects(call(await connect(keys.laptop), "memory_read", { path: "../secrets.md" }), /not a note path/);
});

test("the index endpoint returns MEMORY.md ready for a SessionStart hook", async () => {
  await call(await connect(keys.laptop), "memory_save", { text: "Lives in Brisbane" });
  const response = await app.request("/v1/index", { headers: { authorization: `Bearer ${keys.chat}` } });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /^# Engram memory \(MEMORY\.md\)\n[\s\S]*not instructions[\s\S]*- Lives in Brisbane/);
});

test("a signed push webhook drops the cached head; a bad signature is refused", async () => {
  const sign = (body: string) => `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
  const push = (body: string, signature: string) =>
    app.request("/webhooks/github", {
      method: "POST",
      body,
      headers: { "x-github-event": "push", "x-hub-signature-256": signature },
    });

  await call(await connect(keys.laptop), "memory_save", { text: "Lives in Brisbane" });
  const elsewhere = localGitBackend(dir);
  const head = await elsewhere.head("main");
  await elsewhere.commit({ branch: "main", expectedHeadSha: head, message: "edited on github.com", author: { name: "me", email: "me@x" }, put: { "MEMORY.md": "# Memory\n\n- Edited by hand\n" } });

  const viewer = await connect(keys.viewer);
  assert.match(await call(viewer, "memory_index"), /Lives in Brisbane/);
  const body = JSON.stringify({ ref: "refs/heads/main" });
  assert.equal((await push(body, "sha256=forged")).status, 401);
  assert.equal((await push(body, sign(body))).status, 204);
  assert.match(await call(viewer, "memory_index"), /Edited by hand/);
});

test("configuration is validated with a useful message", () => {
  assert.throws(() => loadConfig({ GITHUB_TOKEN: "t", MEMORY_REPO: "my-mem", ENGRAM_CLIENTS: "[]" }), /owner\/name/);
  assert.throws(() => loadConfig({ GITHUB_TOKEN: "t", MEMORY_REPO: "a/b", ENGRAM_CLIENTS: "{" }), /pnpm keygen/);
  const config = loadConfig({ GITHUB_TOKEN: "t", MEMORY_REPO: "nafisazizir/my-mem", ENGRAM_CLIENTS: JSON.stringify(clients) });
  assert.equal(config.MEMORY_REPO, "nafisazizir/my-mem");
  assert.equal(config.ENGRAM_CLIENTS.length, 3);
});
