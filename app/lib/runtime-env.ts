type RuntimeBindings = Record<string, unknown>;

let workerBindings: RuntimeBindings = {};

export function configureRuntimeEnv(bindings: RuntimeBindings) {
  workerBindings = bindings;
}

export function runtimeEnv(name: string) {
  const workerValue = workerBindings[name];
  if (typeof workerValue === "string" && workerValue.trim()) return workerValue.trim();
  const processValue = process.env[name];
  return typeof processValue === "string" && processValue.trim() ? processValue.trim() : undefined;
}
