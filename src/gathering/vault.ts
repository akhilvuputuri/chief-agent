import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { Database } from "../db.js";
import { extractPdfText, limits } from "../attachments.js";
import { fileName, invoiceFacts, type InvoiceFacts } from "./facts.js";
export const MAX_COLLECTION_BYTES = 200 * 1024 * 1024;
export function encryptBytes(key: Buffer, bytes: Uint8Array, aad: string) {
  if (key.length !== 32) throw new Error("File encryption is not configured");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
}
export function decryptBytes(key: Buffer, box: Uint8Array, aad: string) {
  const bytes = Buffer.from(box);
  if (key.length !== 32 || bytes.length < 29 || bytes[0] !== 1)
    throw new Error("File is unavailable");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(1, 13));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(bytes.subarray(13, 29));
  try {
    return Buffer.concat([
      decipher.update(bytes.subarray(29)),
      decipher.final(),
    ]);
  } catch {
    throw new Error("File is unavailable");
  }
}
export type PreparedFile = {
  sha256: string;
  name: string;
  bytes: number;
  encrypted: Buffer;
  facts: InvoiceFacts;
};
export class FileVault {
  constructor(
    readonly db: Database,
    private key: Buffer,
  ) {
    if (key.length !== 32) throw new Error("File encryption is not configured");
  }
  async prepare(
    user: string,
    name: string,
    bytes: Uint8Array,
    labels: string[] = [],
  ): Promise<PreparedFile> {
    if (
      !bytes.length ||
      bytes.length > limits.pdfBytes ||
      !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-"))
    )
      throw new Error("Use a PDF up to 20 MB");
    const extracted = await extractPdfText(bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      sha256,
      name: `invoice-${sha256.slice(0, 16)}.pdf`,
      bytes: bytes.length,
      encrypted: encryptBytes(this.key, bytes, `file-v1:${user}:${sha256}`),
      facts: invoiceFacts(
        extracted.text,
        extracted.pages,
        extracted.truncated,
        labels,
      ),
    };
  }
  async put(user: string, file: PreparedFile, inputId?: string) {
    return (
      await this.db.query(
        `INSERT INTO file_artifacts(id,user_id,sha256,name,mime_type,bytes,encrypted,facts,input_id)
      VALUES($1,$2,$3,$4,'application/pdf',$5,$6,$7::jsonb,$8)
      ON CONFLICT(user_id,sha256) DO UPDATE SET sha256=EXCLUDED.sha256
      RETURNING id,sha256,name,mime_type,bytes,facts`,
        [
          randomUUID(),
          user,
          file.sha256,
          file.name,
          file.bytes,
          file.encrypted,
          JSON.stringify(file.facts),
          inputId ?? null,
        ],
      )
    ).rows[0];
  }
  async inbound(
    user: string,
    inputId: string,
    name: string,
    bytes: Uint8Array,
  ) {
    return this.put(
      user,
      await this.prepare(user, name, bytes, [
        "ChatGPT",
        "Anthropic",
        "DigitalOcean",
      ]),
      inputId,
    );
  }
  async read(user: string, id: string) {
    const row = (
      await this.db.query(
        "SELECT * FROM file_artifacts WHERE id=$1 AND user_id=$2",
        [id, user],
      )
    ).rows[0];
    if (!row) throw new Error("File is unavailable");
    const data = decryptBytes(
      this.key,
      row.encrypted,
      `file-v1:${user}:${row.sha256}`,
    );
    if (
      data.length !== row.bytes ||
      createHash("sha256").update(data).digest("hex") !== row.sha256
    )
      throw new Error("File is unavailable");
    return {
      id: row.id,
      name: row.name,
      mimeType: row.mime_type,
      data,
      facts: row.facts as InvoiceFacts,
    };
  }
  async list(user: string, offset = 0) {
    const rows = (
      await this.db.query(
        "SELECT id,name,bytes,created_at FROM file_artifacts WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 21 OFFSET $2",
        [user, offset],
      )
    ).rows;
    return {
      files: rows.slice(0, 20),
      nextOffset: rows.length > 20 ? offset + 20 : null,
    };
  }
}
