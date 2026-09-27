import type { EndpointFailureState, FailoverState } from "./types.ts";
import { redactRpcUrl } from "./redact.ts";

export function createFailoverState(): FailoverState {
  return { endpoints: new Map() };
}

function getOrCreateEntry(state: FailoverState, url: string): EndpointFailureState {
  let entry = state.endpoints.get(url);
  if (!entry) {
    entry = {
      cooldownUntil: 0,
      cooldownLoggedUntil: 0,
      methodCooldownUntil: new Map(),
      methodCooldownLoggedUntil: new Map(),
    };
    state.endpoints.set(url, entry);
  }
  return entry;
}

export function isEndpointCoolingDown(state: FailoverState, url: string, now: number): boolean {
  const entry = state.endpoints.get(url);
  return entry != null && entry.cooldownUntil > now;
}

export function isMethodUnavailable(state: FailoverState, url: string, method: string, now: number): boolean {
  const entry = state.endpoints.get(url);
  if (!entry) return false;
  const until = entry.methodCooldownUntil.get(method);
  return typeof until === "number" && until > now;
}

/**
 * Demotes `url` for every method for `cooldownMs`. Logs exactly once per
 * fresh demotion (a transition from "not cooling down" to "cooling down"),
 * never on every subsequent request while the cooldown is still active --
 * that's what `cooldownLoggedUntil` guards.
 */
export function recordEndpointFailure(
  state: FailoverState,
  url: string,
  cooldownMs: number,
  reason: string,
  now: number,
  logger: (line: string) => void,
): void {
  const entry = getOrCreateEntry(state, url);
  const wasCoolingDown = entry.cooldownUntil > now;
  const proposedUntil = now + cooldownMs;
  if (proposedUntil > entry.cooldownUntil) entry.cooldownUntil = proposedUntil;
  if (!wasCoolingDown && entry.cooldownLoggedUntil <= now) {
    entry.cooldownLoggedUntil = entry.cooldownUntil;
    logger(
      `vsol rpc-failover: demoting ${redactRpcUrl(url)} for ${Math.round(cooldownMs / 1000)}s (${reason})`,
    );
  }
}

/** Same idea as recordEndpointFailure, scoped to one JSON-RPC method. */
export function recordMethodUnavailable(
  state: FailoverState,
  url: string,
  method: string,
  cooldownMs: number,
  reason: string,
  now: number,
  logger: (line: string) => void,
): void {
  const entry = getOrCreateEntry(state, url);
  const previousUntil = entry.methodCooldownUntil.get(method) ?? 0;
  const wasCoolingDown = previousUntil > now;
  const proposedUntil = now + cooldownMs;
  if (proposedUntil > previousUntil) entry.methodCooldownUntil.set(method, proposedUntil);
  const previousLoggedUntil = entry.methodCooldownLoggedUntil.get(method) ?? 0;
  if (!wasCoolingDown && previousLoggedUntil <= now) {
    entry.methodCooldownLoggedUntil.set(method, proposedUntil);
    logger(
      `vsol rpc-failover: ${redactRpcUrl(url)} does not support "${method}" for ${Math.round(cooldownMs / 1000)}s (${reason})`,
    );
  }
}
