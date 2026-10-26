import { hashKey, newKey } from "./clients.js";

const [name, access] = process.argv.slice(2);
if (!name || !access) {
  console.error("Usage: pnpm keygen <client-name> <main|inbox|read-only>");
  process.exit(1);
}

const key = newKey();
const entry = { name, keySha256: hashKey(key), writeBranch: access === "read-only" ? null : access };
console.log(`Key for ${name} (shown once; give it to the client, store nowhere else):\n\n  ${key}\n`);
console.log(`Add to ENGRAM_CLIENTS:\n\n  ${JSON.stringify(entry)}\n`);
