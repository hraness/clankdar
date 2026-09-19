/** Read a bounded stream with one total deadline; never buffer a whole request first. */
export async function readBody(req: Request, cap: number, timeoutMs = 5_000): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk === null) { cancel(); return null; }
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > cap) { cancel(); return null; }
      chunks.push(chunk.value);
    }
  } finally {
    clearTimeout(timer!);
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
