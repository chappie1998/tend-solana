import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import idl from "../vsol/target/idl/vsol.json" with { type: "json" };

// Problem 3: the UI's PROTOCOL_WIN_FEE_BPS (app/lib/options.ts) is a
// hand-maintained mirror of the onchain Config.fee_bps -- this reads the real
// value instead. decodeConfigAccount (app/lib/vsol-server.ts) is pure (no RPC,
// no env), so it's testable directly against a synthetic buffer, exactly like
// tests/pool-depth.test.mjs already does for other pure decode/math helpers
// in the same file.
const root = new URL("../", import.meta.url);

async function loadServer() {
  return import(new URL("app/lib/vsol-server.ts", root));
}

function configDiscriminator() {
  const account = idl.accounts.find((entry) => entry.name === "Config");
  assert.ok(account, "the IDL must still declare a Config account");
  return Buffer.from(account.discriminator);
}

// Computes each field's byte offset (after the 8-byte discriminator) straight
// from the IDL's own Config struct, independently of decodeConfigAccount's
// hardcoded offsets -- so this test fails if the two ever drift, rather than
// just re-asserting the same literal decodeConfigAccount already uses.
function primitiveSize(type) {
  if (type === "u8" || type === "bool") return 1;
  if (type === "u16") return 2;
  if (type === "u32") return 4;
  if (type === "u64" || type === "i64") return 8;
  if (type === "pubkey") return 32;
  if (typeof type === "object" && type.array) {
    const [elementType, length] = type.array;
    return primitiveSize(elementType) * length;
  }
  throw new Error(`Unhandled IDL primitive type in this test: ${JSON.stringify(type)}`);
}

function configFieldOffset(fieldName) {
  const configType = idl.types.find((entry) => entry.name === "Config");
  assert.ok(configType, "the IDL must still declare a Config type");
  let offset = 8; // account discriminator
  for (const field of configType.type.fields) {
    if (field.name === fieldName) return offset;
    offset += primitiveSize(field.type);
  }
  throw new Error(`Config has no field named ${fieldName}`);
}

function buildConfigBuffer({ feeBps = 1_000, paused = false, eligibilityRequired = false, domainVersion = 3 } = {}) {
  const configType = idl.types.find((entry) => entry.name === "Config");
  const totalSize = 8 + configType.type.fields.reduce((sum, field) => sum + primitiveSize(field.type), 0);
  const buffer = Buffer.alloc(totalSize);
  configDiscriminator().copy(buffer, 0);
  buffer.writeUInt16LE(feeBps, configFieldOffset("fee_bps"));
  buffer[configFieldOffset("paused")] = paused ? 1 : 0;
  buffer[configFieldOffset("eligibility_required")] = eligibilityRequired ? 1 : 0;
  buffer.writeUInt16LE(domainVersion, configFieldOffset("domain_version"));
  return buffer;
}

test("the IDL's own Config struct places fee_bps at byte offset 201, matching decodeConfigAccount's hardcoded offset", async () => {
  assert.equal(configFieldOffset("fee_bps"), 201);
});

test("decodeConfigAccount reads fee_bps as a u16, independent of paused/domainVersion", async () => {
  const { decodeConfigAccount } = await loadServer();
  const buffer = buildConfigBuffer({ feeBps: 1_000, domainVersion: 7, paused: true });
  const decoded = decodeConfigAccount(buffer);
  assert.equal(decoded.feeBps, 1_000);
  assert.equal(decoded.domainVersion, 7);
  assert.equal(decoded.paused, true);
});

test("decodeConfigAccount's feeBps round-trips the full u16 range, including the documented MAX_FEE_BPS cap of 1000", async () => {
  const { decodeConfigAccount } = await loadServer();
  for (const feeBps of [0, 500, 1_000, 65_535]) {
    assert.equal(decodeConfigAccount(buildConfigBuffer({ feeBps })).feeBps, feeBps);
  }
});

test("decodeConfigAccount still enforces the exact 239-byte account size and discriminator (feeBps did not loosen this check)", async () => {
  const { decodeConfigAccount } = await loadServer();
  const buffer = buildConfigBuffer({});
  assert.equal(buffer.length, 239);
  assert.throws(() => decodeConfigAccount(buffer.subarray(0, 238)), /discriminator or size is invalid/);
  const wrongDiscriminator = Buffer.from(buffer);
  wrongDiscriminator[0] ^= 0xff;
  assert.throws(() => decodeConfigAccount(wrongDiscriminator), /discriminator or size is invalid/);
});

test("app/api/quotes/route.ts reads protocolFeeBps from poolCore.config.feeBps, not from app/lib/options.ts's PROTOCOL_WIN_FEE_BPS mirror", async () => {
  const source = await readFile(new URL("app/api/quotes/route.ts", root), "utf8");
  assert.match(source, /const protocolFeeBps = poolCore\.config\.feeBps;/);
  // The route never IMPORTS PROTOCOL_WIN_FEE_BPS -- a comment may mention it
  // in prose (explaining why the live value is used instead), but the value
  // itself must never be pulled from app/lib/options.ts here.
  const optionsImportLine = source.split("\n").find((line) => line.includes('from "../../lib/options"'));
  assert.ok(optionsImportLine, "the route must still import from app/lib/options.ts (payoffTiersFor etc.)");
  assert.doesNotMatch(optionsImportLine, /PROTOCOL_WIN_FEE_BPS/);
});

test("app/lib/options.ts still documents PROTOCOL_WIN_FEE_BPS as an explicitly-labelled fallback, not the source of truth", async () => {
  const source = await readFile(new URL("app/lib/options.ts", root), "utf8");
  assert.match(source, /export const PROTOCOL_WIN_FEE_BPS = 1_000;/);
  // netWinning must still take an explicit rate (the route/UI pass the live
  // on-chain figure through it) rather than always defaulting silently.
  assert.match(source, /export function netWinning\(maxPayout: number, feeBps: number = PROTOCOL_WIN_FEE_BPS\)/);
});
