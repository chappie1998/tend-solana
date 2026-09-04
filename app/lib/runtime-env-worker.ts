// Host-side environment bootstrap, imported for its side effect by every API
// route before anything reads `runtimeEnv()`.
//
// On Cloudflare this pushed the Worker's `env` bindings into the runtime-env
// registry, because Workers do not populate `process.env`. On Vercel (Node
// runtime) `process.env` is the real source and `runtimeEnv()` already reads
// it, so there is nothing to inject. The module is kept as a stable import
// target so route files stay identical across hosts, and so the hook is here
// if a future host needs binding injection again.
export {};
