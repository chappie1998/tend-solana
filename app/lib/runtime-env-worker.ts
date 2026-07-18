import { env } from "cloudflare:workers";
import { configureRuntimeEnv } from "./runtime-env";

configureRuntimeEnv(env as unknown as Record<string, unknown>);
