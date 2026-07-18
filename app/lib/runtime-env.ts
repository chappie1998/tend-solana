type RuntimeBindings = Record<string, unknown>;

let workerBindings: RuntimeBindings = {};

try {
  // Sites/Cloudflare runtime values live on the Workers env binding. Keeping the
  // module name dynamic lets protocol scripts continue to run under plain Node.
  const moduleName = "cloudflare:workers";
  const workers = await import(moduleName) as { env?: RuntimeBindings };
  workerBindings = workers.env ?? {};
} catch {
  // Plain Node and local protocol scripts have no cloudflare: URL loader.
}

export function runtimeEnv(name: string) {
  const workerValue = workerBindings[name];
  if (typeof workerValue === "string" && workerValue.trim()) return workerValue.trim();
  const processValue = process.env[name];
  return typeof processValue === "string" && processValue.trim() ? processValue.trim() : undefined;
}
