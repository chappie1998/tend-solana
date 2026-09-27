// RPC endpoints carry API keys in their path or query string (Helius,
// Alchemy, ...). Every log line this module ever emits must reduce a URL to
// its host before printing it -- never the full string.

export function redactRpcUrl(url: string): string {
  try {
    return new URL(url).host || "[unknown-host]";
  } catch {
    return "[unparseable-endpoint]";
  }
}
