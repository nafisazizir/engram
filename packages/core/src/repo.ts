import { type Author, type GrepHit, type MemoryBackend, MemoryConflictError } from "./backend.ts";
import {
  INDEX_FILE,
  addIndexLink,
  appendEntry,
  assertNotePath,
  formatEntry,
  hasEntry,
  type Meta,
  normalizeText,
  removeEntry,
} from "./entries.ts";

const MAX_WRITE_ATTEMPTS = 8;
const DEFAULT_SEARCH_LIMIT = 50;

export interface MemoryRepoOptions {
  backend: MemoryBackend;
  author: Author;
  branch?: string;
  // An inbox writer reads `branch` but commits to `writeBranch`, which is reviewed before merging.
  writeBranch?: string;
  today?: () => string;
}

export interface SaveInput {
  text: string;
  file?: string;
  source?: string;
  meta?: Meta;
}

export interface RemoveInput {
  text: string;
  file?: string;
}

export interface WriteResult {
  changed: boolean;
  file: string;
  commit?: string;
}

export interface MemoryRepo {
  index(): Promise<string | null>;
  read(path: string): Promise<string | null>;
  list(): Promise<string[]>;
  search(pattern: string, limit?: number): Promise<GrepHit[]>;
  save(input: SaveInput): Promise<WriteResult>;
  remove(input: RemoveInput): Promise<WriteResult>;
}

type Edit = (read: (path: string) => Promise<string | null>) => Promise<Record<string, string> | null>;

export function memoryRepo(options: MemoryRepoOptions): MemoryRepo {
  const { backend, author } = options;
  const branch = options.branch ?? "main";
  const writeBranch = options.writeBranch ?? branch;
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));

  async function write(message: string, edit: Edit): Promise<string | null> {
    for (let attempt = 1; ; attempt += 1) {
      const head = await backend.head(writeBranch);
      const seed = head ?? (writeBranch === branch ? null : await backend.head(branch));
      const put = await edit((path) => (seed === null ? Promise.resolve(null) : backend.readFile(path, seed)));
      if (put === null) return null;
      try {
        return await backend.commit({
          branch: writeBranch,
          expectedHeadSha: head,
          ...(head === null && seed !== null && { baseBranch: branch }),
          message,
          author,
          put,
        });
      } catch (error) {
        if (!MemoryConflictError.is(error) || attempt >= MAX_WRITE_ATTEMPTS) throw error;
      }
    }
  }

  return {
    index: () => backend.readFile(INDEX_FILE, branch),

    async read(path) {
      assertNotePath(path);
      return backend.readFile(path, branch);
    },

    async list() {
      return (await backend.listFiles(branch)).toSorted();
    },

    search(pattern, limit = DEFAULT_SEARCH_LIMIT) {
      return backend.grep(pattern, branch, limit);
    },

    async save(input) {
      const file = input.file ?? INDEX_FILE;
      assertNotePath(file);
      const text = normalizeText(input.text);
      const line = formatEntry({
        text,
        meta: { ...(input.source && { source: input.source }), added: today(), ...input.meta },
      });
      const commit = await write(`memory: save to ${file}\n\n${text}`, async (read) => {
        const content = await read(file);
        if (hasEntry(content, text)) return null;
        const put = { [file]: appendEntry(content, file, line) };
        if (content === null && file !== INDEX_FILE) put[INDEX_FILE] = addIndexLink(await read(INDEX_FILE), file);
        return put;
      });
      return commit === null ? { changed: false, file } : { changed: true, file, commit };
    },

    async remove(input) {
      const file = input.file ?? INDEX_FILE;
      assertNotePath(file);
      const text = normalizeText(input.text);
      const commit = await write(`memory: remove from ${file}\n\n${text}`, async (read) => {
        const next = removeEntry(await read(file), text);
        return next === null ? null : { [file]: next };
      });
      return commit === null ? { changed: false, file } : { changed: true, file, commit };
    },
  };
}
