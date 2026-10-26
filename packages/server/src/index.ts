import { cachedBackend, githubBackend } from "@nafisazizir/engram-core";

import { loadConfig, todayIn } from "./config.js";
import { createApp } from "./routes.js";

const config = loadConfig();
const [owner = "", repo = ""] = config.ENGRAM_REPO.split("/");

export default createApp({
  backend: cachedBackend(githubBackend({ owner, repo, token: config.GITHUB_TOKEN })),
  clients: config.ENGRAM_CLIENTS,
  readBranch: config.ENGRAM_BRANCH,
  today: todayIn(config.ENGRAM_TIMEZONE),
  ...(config.GITHUB_WEBHOOK_SECRET && { webhookSecret: config.GITHUB_WEBHOOK_SECRET }),
});
