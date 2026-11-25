// Bytes to text for the file reader: a byte order mark wins over the declared encoding (UTF-8, UTF-16 LE/BE), and a
// multi-byte character may span chunks.
import type { FILE_ENCODINGS } from "@starterkit/shared/sources";

const BOMS: [number[], string][] = [[[0xef, 0xbb, 0xbf], "utf-8"], [[0xff, 0xfe], "utf-16le"], [[0xfe, 0xff], "utf-16be"]];

/** The encoding a byte order mark names, with its length; null without one. */
export function bomOf(head: Uint8Array): { encoding: string; length: number } | null {
  for (const [mark, encoding] of BOMS) if (mark.every((b, i) => head[i] === b)) return { encoding, length: mark.length };
  return null;
}

/** The text of a byte stream, decoded by its byte order mark (dropped) or else `encoding`. */
export async function* decodeStream(bytes: AsyncIterable<Uint8Array>, encoding: (typeof FILE_ENCODINGS)[number]): AsyncGenerator<string> {
  let decoder: TextDecoder | null = null;
  let pending: Uint8Array = new Uint8Array(0);
  for await (const b of bytes) {
    if (!decoder) {
      const head = pending.length ? new Uint8Array([...pending, ...b]) : b;
      if (head.length < 3) { pending = head; continue; }
      const bom = bomOf(head);
      decoder = new TextDecoder((bom?.encoding ?? encoding) as "utf-8");
      yield decoder.decode(head.subarray(bom?.length ?? 0), { stream: true });
      pending = new Uint8Array(0);
      continue;
    }
    yield decoder.decode(b, { stream: true });
  }
  if (!decoder) {
    const bom = bomOf(pending);
    decoder = new TextDecoder((bom?.encoding ?? encoding) as "utf-8");
    yield decoder.decode(pending.subarray(bom?.length ?? 0));
    return;
  }
  yield decoder.decode();
}
