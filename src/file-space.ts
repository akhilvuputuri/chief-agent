import { randomBytes } from "node:crypto";
import { ToolValidationError } from "./tool-errors.js";

/** One file a tool made or fetched during a conversation. */
export type SpaceFile = {
  fileId: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
  /** Where it came from, for example `gmail:primary:<messageId>:<partId>` or `zip`. */
  source: string;
  createdAt: number;
  touchedAt: number;
};

// The space lives in the gateway's memory on a small server.
export const FILE_MAX = 20 * 1024 * 1024;
export const OWNER_MAX = 100 * 1024 * 1024;
/** A file is dropped this long after it was put there or last sent, saved or zipped. */
export const IDLE_MS = 60 * 60_000;

/** A filename safe for Telegram and a ZIP entry: no control, format or path characters. */
export function spaceName(name: string) {
  return (
    name
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .replace(/[\\/:]/g, "_")
      .trim()
      .slice(0, 200) || "file"
  );
}

/**
 * The coordinator's scratch space for files during a conversation: per owner, in memory
 * only, so a restart empties it. Files expire an hour after they were last touched, and
 * the oldest are dropped when an owner's files pass OWNER_MAX. Bytes never go to the model;
 * tools return a file's handle and facts.
 */
export class FileSpace {
  private readonly owners = new Map<string, Map<string, SpaceFile>>();
  constructor(private readonly now: () => number = Date.now) {}

  put(
    user: string,
    file: { name: string; mimeType: string; bytes: Buffer; source: string },
  ) {
    if (!file.bytes.length) throw new ToolValidationError("The file is empty");
    if (file.bytes.length > FILE_MAX)
      throw new ToolValidationError(
        "Files in the file space are at most 20 MiB each",
      );
    this.prune();
    const files = this.owners.get(user) ?? new Map<string, SpaceFile>();
    this.owners.set(user, files);
    let total =
      file.bytes.length +
      [...files.values()].reduce((sum, f) => sum + f.bytes.length, 0);
    // Least recently touched first; Map order is insertion order, refreshed on touch.
    for (const [id, old] of files) {
      if (total <= OWNER_MAX) break;
      files.delete(id);
      total -= old.bytes.length;
    }
    const at = this.now();
    const entry: SpaceFile = {
      fileId: `f-${randomBytes(6).toString("hex")}`,
      name: spaceName(file.name),
      mimeType: file.mimeType,
      bytes: file.bytes,
      source: file.source,
      createdAt: at,
      touchedAt: at,
    };
    files.set(entry.fileId, entry);
    return describe(entry, at);
  }

  /** The file, touched so it stays another hour; refused when it is gone. */
  get(user: string, fileId: string) {
    this.prune();
    const files = this.owners.get(user);
    const file = files?.get(fileId);
    if (!files || !file)
      throw new ToolValidationError(
        `No file ${fileId} in the file space: files expire an hour after last use and are gone after a restart. file_list shows what is there.`,
      );
    file.touchedAt = this.now();
    files.delete(fileId);
    files.set(fileId, file);
    return file;
  }

  list(user: string) {
    this.prune();
    const at = this.now();
    return [...(this.owners.get(user)?.values() ?? [])].map((f) =>
      describe(f, at),
    );
  }

  private prune() {
    const cutoff = this.now() - IDLE_MS;
    for (const [user, files] of this.owners) {
      for (const [id, file] of files)
        if (file.touchedAt < cutoff) files.delete(id);
      if (!files.size) this.owners.delete(user);
    }
  }
}

/** What a tool returns about a file: its handle and facts, never its bytes. */
export function describe(file: SpaceFile, now = Date.now()) {
  return {
    fileId: file.fileId,
    name: file.name,
    mimeType: file.mimeType,
    bytes: file.bytes.length,
    source: file.source,
    ageMinutes: Math.floor((now - file.createdAt) / 60_000),
  };
}
