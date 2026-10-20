import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { COPY } from "./copy.ts";
import { rendered, type View } from "./blocks.ts";

type Part = TextContent | ImageContent;
const PAGE_CHARS = 12_000;
function split(text: string): TextContent[] {
  const result: TextContent[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + PAGE_CHARS);
    // Never produce a lone surrogate at a page boundary (strict providers reject it).
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    result.push({ type: "text", text: text.slice(start, end) });
    start = end;
  }
  return result;
}
function original(entry: SessionEntry): Part[] {
  if (entry.type !== "message") throw new Error(COPY.missing);
  const message = entry.message;
  if (!("content" in message)) throw new Error(COPY.missing);
  const metadata = message.role === "toolResult" ? JSON.stringify({ toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError }) : message.role;
  const parts: Part[] = [{ type: "text", text: COPY.evidence(entry.id, metadata) }];
  if (typeof message.content === "string") return [...parts, ...split(message.content)];
  for (const part of message.content) {
    if (part.type === "text") parts.push(...split(part.text));
    else if (part.type === "image") parts.push(part);
    else if (part.type === "toolCall") parts.push(...split(JSON.stringify({ tool: part.name, toolCallId: part.id, arguments: part.arguments })));
    // Never replay opaque provider reasoning as ordinary tool text or leak its signature.
    else if (part.type === "thinking") parts.push({ type: "text", text: COPY.hiddenThinking });
  }
  return parts;
}
export function recall(view: View, ref: string, mode: "one" | "full", offset: number, images: boolean, query?: string) {
  const entries = new Map(view.branch.map(e => [e.id, e]));
  let parts: Part[] = [];
  if (ref.startsWith("@")) {
    const entry = entries.get(ref.slice(1));
    if (!entry) throw new Error(COPY.missing);
    parts = original(entry);
  } else {
    const block = view.blocks.get(ref);
    if (!block) throw new Error(COPY.unknownBlock);
    if (block.covered.some(id => !entries.has(id))) throw new Error(COPY.missing);
    if (mode === "full") {
      const wanted = new Set(block.covered);
      parts = view.branch.filter(e => wanted.has(e.id)).flatMap(original);
    } else {
      const childByCarrier = new Map(block.children.map(id => {
        const child = view.blocks.get(id);
        if (!child) throw new Error(COPY.missing);
        return [child.carrier, child] as const;
      }));
      const direct = new Set(block.direct);
      for (const entry of view.branch) {
        const child = childByCarrier.get(entry.id);
        if (child) parts.push(...split(rendered(child)));
        else if (direct.has(entry.id)) parts.push(...original(entry));
      }
    }
  }
  if (query) parts = parts.filter(p => p.type === "text" && p.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if (offset > parts.length) throw new Error(COPY.offset);
  const content: Part[] = [];
  let chars = 0, cursor = offset;
  while (cursor < parts.length) {
    const part = parts[cursor];
    if (part.type === "image") {
      if (content.length) break;
      if (!images) throw new Error(COPY.imageUnsupported);
      content.push(part); cursor++; break;
    }
    if (chars + part.text.length > PAGE_CHARS && content.length) break;
    content.push(part); chars += part.text.length; cursor++;
  }
  const details = { ref, mode, offset, nextOffset: cursor < parts.length ? cursor : null, complete: cursor === parts.length,
    coverage: query ? "matching-parts" : "requested-view", totalParts: parts.length, ...(query ? { query } : {}) };
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }, ...content], details };
}
