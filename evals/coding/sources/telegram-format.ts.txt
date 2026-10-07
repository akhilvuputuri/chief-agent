import type { MessageEntity } from "grammy/types";
export interface FormattedMessage {
  text: string;
  entities: MessageEntity[];
}
/** Render a deliberately small Markdown subset as text + explicit Telegram entities.
 * Raw HTML stays literal. Offsets use UTF-16, as required by Telegram. */
export function formatTelegram(
  input: string,
  limit = 3500,
): FormattedMessage[] {
  if (limit < 32 || limit > 4096) throw new Error("Invalid message limit");
  let text = "";
  const entities: MessageEntity[] = [];
  const inline = (s: string) => {
    const pattern =
      /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
    let cursor = 0;
    for (const m of s.matchAll(pattern)) {
      text += s.slice(cursor, m.index);
      const raw = m[0];
      const offset = text.length;
      if (raw.startsWith("[")) {
        const split = raw.indexOf("](");
        text += raw.slice(1, split);
        entities.push({
          type: "text_link",
          offset,
          length: text.length - offset,
          url: raw.slice(split + 2, -1),
        });
      } else {
        const size = raw.startsWith("**") ? 2 : 1;
        text += raw.slice(size, -size);
        entities.push({
          type: raw.startsWith("`") ? "code" : size === 2 ? "bold" : "italic",
          offset,
          length: text.length - offset,
        });
      }
      cursor = m.index! + raw.length;
    }
    text += s.slice(cursor);
  };
  let codeStart: number | undefined;
  for (const line of input.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*```/.test(line)) {
      if (codeStart === undefined) codeStart = text.length;
      else {
        if (text.length > codeStart)
          entities.push({
            type: "pre",
            offset: codeStart,
            length: text.length - codeStart,
          });
        codeStart = undefined;
      }
      continue;
    }
    if (codeStart !== undefined) {
      text += line + "\n";
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      if (!text.endsWith("\n\n")) text += "\n";
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      const start = text.length;
      const before = entities.length;
      inline(heading[1]!);
      entities.splice(before);
      if (text.length > start)
        entities.push({
          type: "bold",
          offset: start,
          length: text.length - start,
        });
    } else inline(line.replace(/^\s*[-*+]\s+/, "• "));
    text += "\n";
  }
  if (codeStart !== undefined && text.length > codeStart)
    entities.push({
      type: "pre",
      offset: codeStart,
      length: text.length - codeStart,
    });
  // Do not trim the start: it would invalidate entity offsets.
  text = text.trimEnd();
  const chunks: FormattedMessage[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const paragraph = text.lastIndexOf("\n\n", end);
      const line = text.lastIndexOf("\n", end);
      const space = text.lastIndexOf(" ", end);
      const boundary =
        paragraph > start + limit / 2
          ? paragraph + 2
          : line > start + limit / 2
            ? line + 1
            : space > start + limit / 2
              ? space + 1
              : end;
      end = Math.min(end, boundary);
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    }
    const scoped = entities
      .filter((e) => e.offset < end && e.offset + e.length > start)
      .map((e) => ({
        ...e,
        offset: Math.max(e.offset, start) - start,
        length: Math.min(e.offset + e.length, end) - Math.max(e.offset, start),
      }));
    chunks.push({ text: text.slice(start, end), entities: scoped });
    start = end;
  }
  return chunks;
}
