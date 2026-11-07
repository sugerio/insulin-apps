const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 + 65536;
const MAX_UPLOAD_CHUNKS = 65536;
export const CANDIDATE_UPLOAD_DEADLINE_MS = 10000;

/** Bounds the whole upload, not the time between successive chunks. */
export async function readCandidateUpload(body: ReadableStream<Uint8Array> | null, deadlineMs = CANDIDATE_UPLOAD_DEADLINE_MS, maxBytes = MAX_UPLOAD_BYTES): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  let complete = false; let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Upload deadline')), deadlineMs); });
  const read = async (): Promise<Uint8Array> => {
    let bytes = new Uint8Array(0); let size = 0; let chunks = 0;
    for (;;) {
      const part = await reader.read();
      if (stopped) throw new Error('Upload stopped');
      if (part.done) { complete = true; return bytes.slice(0, size); }
      if (++chunks > MAX_UPLOAD_CHUNKS) throw new Error('Too many upload chunks');
      const nextSize = size + part.value.byteLength;
      if (nextSize > maxBytes) throw new Error('Upload too large');
      if (nextSize > bytes.length) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(nextSize, bytes.length * 2, 1024)));
        grown.set(bytes.subarray(0, size)); bytes = grown;
      }
      bytes.set(part.value, size); size = nextSize;
    }
  };
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
