// A small fetch wrapper shared by the Coinbase market-data modules
// (coinbase-market-data.ts, coinbase-market-bars.ts): a timeout, a hard cap
// on response size (checked against the declared Content-Length AND against
// bytes actually read, so a missing/lying header can't bypass it), and
// manual redirect handling.
//
// `redirect: "manual"` (not "error") matches the same workaround already used
// in pyth-market-data.ts / pyth-market-bars.ts: some Worker-style runtimes
// reject `redirect: "error"` outright, while "manual" is accepted everywhere
// and simply yields an opaque response that then fails the `response.ok`
// check below -- either way, a redirect is never silently followed.
export type FetchJsonCappedOptions = {
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  /** Named in every error this throws, e.g. "Coinbase Exchange". */
  label: string;
};

export async function fetchJsonCapped(url: URL, options: FetchJsonCappedOptions): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      headers: options.headers,
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${options.label} returned ${response.status}`);
    const declaredBytes = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > options.maxBytes) {
      throw new Error(`${options.label} response is too large`);
    }
    if (!response.body) throw new Error(`${options.label} response has no body`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > options.maxBytes) {
        await reader.cancel();
        throw new Error(`${options.label} response is too large`);
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body));
  } finally {
    clearTimeout(timeout);
  }
}
