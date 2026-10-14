import assert from "node:assert/strict";

/** Scripted providers must actually consume the reviewer's immutable evidence. */
export function reviewDocumentReader() {
  const cursors = new Map<string, number>();
  return (input: any, key: string) => {
    const system =
      input.messages.find((m: any) => m.role === "system")?.content ?? "";
    const pages = ["candidate_inventory", "candidate_diff"].flatMap((id) => {
      const match = system.match(new RegExp(`${id}: [^\\n]*; (\\d+) pages`));
      assert(match, `Missing ${id} metadata`);
      return Array.from({ length: Number(match[1]) }, (_, page) => ({
        id,
        page,
      }));
    });
    const at = cursors.get(key) ?? 0;
    if (at >= pages.length) {
      const inventory = input.messages
        .filter((m: any) => m.role === "tool" && typeof m.content === "string")
        .map((m: any) => {
          try {
            return JSON.parse(m.content);
          } catch {
            return null;
          }
        })
        .find((m: any) => m?.id === "candidate_inventory");
      assert(inventory, "Inventory was never delivered");
      const manifest = JSON.parse(inventory.text);
      assert(system.includes(manifest.candidateHash));
      assert(system.includes(manifest.baseSha));
      return undefined;
    }
    cursors.set(key, at + 1);
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `evidence-${key}-${at}`,
            type: "function",
            function: {
              name: "read_document",
              arguments: JSON.stringify(pages[at]),
            },
          },
        ],
      },
    };
  };
}
