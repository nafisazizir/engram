export interface Author {
  name: string;
  email: string;
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

export interface Change {
  branch: string;
  // null means the branch must not exist yet; it is created from `baseBranch`, or as a root commit.
  expectedHeadSha: string | null;
  baseBranch?: string;
  message: string;
  author: Author;
  put: Record<string, string>;
  delete?: string[];
}

export interface MemoryBackend {
  head(branch: string): Promise<string | null>;
  readFile(path: string, ref: string): Promise<string | null>;
  listFiles(ref: string): Promise<string[]>;
  grep(pattern: string, ref: string, limit: number): Promise<GrepHit[]>;
  commit(change: Change): Promise<string>;
}

export class MemoryConflictError extends Error {
  readonly name = "MemoryConflictError";

  static is(error: unknown): error is MemoryConflictError {
    return error instanceof MemoryConflictError;
  }
}
