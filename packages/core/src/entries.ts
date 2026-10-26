export const INDEX_FILE = "MEMORY.md";
const INDEX_HEADING = "## Index";
const MAX_ENTRY_BYTES = 2048;

export type Meta = Record<string, string>;

export interface Entry {
  text: string;
  meta: Meta;
}

const ENTRY_LINE = /^- (.+?)(?: \[([a-z][a-z0-9_]*: [^;\[\]]+(?:; [a-z][a-z0-9_]*: [^;\[\]]+)*)\])?$/;
const SAFE_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_][A-Za-z0-9_.\-/]*\.md$/;

export function normalizeText(text: string): string {
  const normalized = text.trim().replaceAll(/\s+/g, " ");
  if (normalized.length === 0) throw new TypeError("Memory text cannot be empty.");
  if (new TextEncoder().encode(normalized).byteLength > MAX_ENTRY_BYTES) {
    throw new RangeError(`Memory text exceeds ${MAX_ENTRY_BYTES} bytes; split it into smaller facts.`);
  }
  return normalized;
}

export function assertNotePath(path: string): void {
  if (!SAFE_PATH.test(path) || path.includes("//")) {
    throw new TypeError(`"${path}" is not a note path; use a relative path ending in .md, such as people/family.md.`);
  }
}

export function parseEntry(line: string): Entry | null {
  const match = ENTRY_LINE.exec(line);
  if (!match?.[1]) return null;
  const meta: Meta = {};
  for (const pair of match[2]?.split("; ") ?? []) {
    const separator = pair.indexOf(": ");
    meta[pair.slice(0, separator)] = pair.slice(separator + 2);
  }
  return { text: match[1], meta };
}

export function formatEntry(entry: Entry): string {
  const pairs = Object.entries(entry.meta)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}: ${value.replaceAll(/[;\[\]]/g, " ").trim()}`);
  return pairs.length === 0 ? `- ${entry.text}` : `- ${entry.text} [${pairs.join("; ")}]`;
}

export function linkTarget(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

export function hasEntry(content: string | null, text: string): boolean {
  return lines(content).some((line) => parseEntry(line)?.text === text);
}

export function appendEntry(content: string | null, path: string, line: string): string {
  if (content === null) return `# ${titleFor(path)}\n\n${line}\n`;
  const body = lines(content);
  const index = body.indexOf(INDEX_HEADING);
  if (index === -1) return join([...trimTrailingBlank(body), line]);
  const before = trimTrailingBlank(body.slice(0, index));
  return join([...before, line, "", ...body.slice(index)]);
}

export function removeEntry(content: string | null, text: string): string | null {
  const body = lines(content);
  const kept = body.filter((line) => parseEntry(line)?.text !== text);
  return kept.length === body.length ? null : join(kept);
}

export function addIndexLink(content: string | null, path: string): string {
  const link = `- [[${linkTarget(path)}]]`;
  const body = content === null ? [`# Memory`] : lines(content);
  if (body.includes(link)) return join(body);
  const index = body.indexOf(INDEX_HEADING);
  if (index === -1) return join([...trimTrailingBlank(body), "", INDEX_HEADING, link]);
  const next = body.findIndex((line, at) => at > index && line.startsWith("## "));
  const end = next === -1 ? body.length : next;
  const section = trimTrailingBlank(body.slice(0, end));
  const rest = body.slice(end);
  return join(rest.length === 0 ? [...section, link] : [...section, link, "", ...rest]);
}

function titleFor(path: string): string {
  if (path === INDEX_FILE) return "Memory";
  const name = linkTarget(path).split("/").at(-1) ?? path;
  const words = name.replaceAll(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function lines(content: string | null): string[] {
  if (content === null || content.length === 0) return [];
  return content.replace(/\n$/, "").split("\n");
}

function trimTrailingBlank(body: string[]): string[] {
  let end = body.length;
  while (end > 0 && body[end - 1]?.trim() === "") end -= 1;
  return body.slice(0, end);
}

function join(body: string[]): string {
  return `${body.join("\n")}\n`;
}
