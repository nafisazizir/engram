import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addIndexLink,
  appendEntry,
  assertNotePath,
  formatEntry,
  hasEntry,
  normalizeText,
  parseEntry,
  removeEntry,
} from "./entries.ts";

test("parses an entry with metadata", () => {
  assert.deepEqual(parseEntry("- Prefers oat milk [source: adam:s1; added: 2026-10-26]"), {
    text: "Prefers oat milk",
    meta: { source: "adam:s1", added: "2026-10-26" },
  });
});

test("keeps a trailing wiki link as text, not metadata", () => {
  assert.deepEqual(parseEntry("- Hotfixes need sign-off from [[team/contacts]]"), {
    text: "Hotfixes need sign-off from [[team/contacts]]",
    meta: {},
  });
});

test("ignores lines that are not entries", () => {
  assert.equal(parseEntry("# Memory"), null);
  assert.equal(parseEntry("## Index"), null);
});

test("formats metadata and strips characters that would break parsing", () => {
  const line = formatEntry({ text: "Runs Tuesdays", meta: { source: "a;b]", added: "2026-10-26", empty: "" } });
  assert.equal(line, "- Runs Tuesdays [source: a b; added: 2026-10-26]");
  assert.deepEqual(parseEntry(line)?.meta, { source: "a b", added: "2026-10-26" });
});

test("creates a titled file for the first entry", () => {
  assert.equal(appendEntry(null, "people/close-family.md", "- Sister is Aisha"), "# Close family\n\n- Sister is Aisha\n");
});

test("inserts entries above the index section", () => {
  const memory = "# Memory\n\n- Lives in Brisbane\n\n## Index\n- [[people]]\n";
  assert.equal(
    appendEntry(memory, "MEMORY.md", "- Works at Avenue2"),
    "# Memory\n\n- Lives in Brisbane\n- Works at Avenue2\n\n## Index\n- [[people]]\n",
  );
});

test("links a new file at the end of the index section, before later sections", () => {
  const memory = "# Memory\n\n## Index\n- [[people]]\n\n## Swarms\n- [[swarms/a/README]]\n";
  assert.equal(
    addIndexLink(memory, "health.md"),
    "# Memory\n\n## Index\n- [[people]]\n- [[health]]\n\n## Swarms\n- [[swarms/a/README]]\n",
  );
  assert.equal(addIndexLink("# Memory\n- A fact\n", "health.md"), "# Memory\n- A fact\n\n## Index\n- [[health]]\n");
  assert.equal(addIndexLink(memory, "people.md"), memory);
});

test("removes an entry by text regardless of its metadata", () => {
  const content = "# Memory\n- A [added: 2026-01-01]\n- B\n";
  assert.equal(removeEntry(content, "A"), "# Memory\n- B\n");
  assert.equal(removeEntry(content, "C"), null);
  assert.ok(hasEntry(content, "A"));
});

test("normalizes whitespace and rejects empty or oversized text", () => {
  assert.equal(normalizeText("  two\n words "), "two words");
  assert.throws(() => normalizeText("   "), TypeError);
  assert.throws(() => normalizeText("x".repeat(2049)), RangeError);
});

test("accepts only relative markdown note paths", () => {
  for (const path of ["MEMORY.md", "people/family.md", "work/avenue2/clients.md"]) assertNotePath(path);
  for (const path of ["/etc/passwd.md", "../outside.md", "a/../b.md", "notes.txt", ".hidden.md", "a//b.md"]) {
    assert.throws(() => assertNotePath(path), TypeError, path);
  }
});
