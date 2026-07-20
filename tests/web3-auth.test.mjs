import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("session cookie HMAC tokens round-trip and reject tampering", async () => {
  const tokens = await import(new URL("app/lib/session-token.ts", root));
  const secret = "unit-test-session-secret-0123456789";
  const wallet = "BxFBP8yFhykSkQobMqyZNdcsLqcZ2eDWGoLjXEEbLQvx";
  const expiresAtMs = Date.now() + 60_000;

  const token = await tokens.mintSessionToken({ wallet, expiresAtMs, secret });
  const claims = await tokens.verifySessionToken(token, secret);
  assert.deepEqual(claims, { wallet, expiresAtMs });

  // Tampered payload: swap the wallet inside the signed payload.
  const [version, payload, signature] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({
    w: "7SoGgfH5a89Gx4fBFip3oSPozTLEmZjU2sxjKcEe3782",
    e: expiresAtMs,
  })).toString("base64url");
  assert.equal(await tokens.verifySessionToken(`${version}.${forgedPayload}.${signature}`, secret), null);

  // Tampered signature.
  const flipped = signature.slice(0, -1) + (signature.at(-1) === "A" ? "B" : "A");
  assert.equal(await tokens.verifySessionToken(`${version}.${payload}.${flipped}`, secret), null);

  // Wrong secret, expiry in the past, structural garbage.
  assert.equal(await tokens.verifySessionToken(token, "a-different-secret-0123456789"), null);
  assert.equal(await tokens.verifySessionToken(token, secret, expiresAtMs + 1), null);
  assert.equal(await tokens.verifySessionToken("v1.not-a-token", secret), null);
  assert.equal(await tokens.verifySessionToken("", secret), null);

  // Minting is strict about inputs.
  await assert.rejects(() => tokens.mintSessionToken({ wallet: "not-base58!", expiresAtMs, secret }), /base58/);
  await assert.rejects(() => tokens.mintSessionToken({ wallet, expiresAtMs, secret: "short" }), /16 characters/);

  // Cookie attributes: HTTP-only, SameSite=Lax, Secure toggled by caller.
  const secureCookie = tokens.serializeSessionCookie(token, { secure: true });
  assert.match(secureCookie, /^tend_session=/);
  assert.match(secureCookie, /HttpOnly/);
  assert.match(secureCookie, /SameSite=Lax/);
  assert.match(secureCookie, /Secure/);
  const localCookie = tokens.serializeSessionCookie(token, { secure: false });
  assert.doesNotMatch(localCookie, /Secure/);
  assert.match(tokens.clearSessionCookie({ secure: true }), /Max-Age=0/);
  assert.deepEqual(tokens.parseCookies(`x=1; tend_session=${token}; y=2`), { x: "1", tend_session: token, y: "2" });
  assert.deepEqual(tokens.parseCookies(null), {});
});

test("SIWS messages are canonical and strictly validated", async () => {
  const siws = await import(new URL("app/lib/siws.ts", root));
  const fields = {
    domain: "tend.example.com:8443",
    walletAddress: "BxFBP8yFhykSkQobMqyZNdcsLqcZ2eDWGoLjXEEbLQvx",
    nonce: "ab".repeat(32),
    issuedAtMs: Date.parse("2026-07-20T12:00:00.000Z"),
    expiresAtMs: Date.parse("2026-07-20T12:05:00.000Z"),
  };
  const message = siws.buildSiwsMessage(fields);
  assert.equal(message, [
    "tend.example.com:8443 wants you to sign in with your Solana account:",
    "BxFBP8yFhykSkQobMqyZNdcsLqcZ2eDWGoLjXEEbLQvx",
    "",
    siws.SIWS_STATEMENT,
    "",
    "Domain: tend.example.com:8443",
    `Nonce: ${"ab".repeat(32)}`,
    "Issued At: 2026-07-20T12:00:00.000Z",
    "Expiration Time: 2026-07-20T12:05:00.000Z",
    "Version: 1",
  ].join("\n"));

  // Identical fields → identical bytes; any field change → different message.
  assert.equal(siws.buildSiwsMessage(fields), message);
  assert.notEqual(siws.buildSiwsMessage({ ...fields, nonce: "cd".repeat(32) }), message);

  // Injection and malformed inputs fail closed.
  assert.throws(() => siws.buildSiwsMessage({ ...fields, domain: "evil.com\nNonce: forged" }), /domain is invalid/);
  assert.throws(() => siws.buildSiwsMessage({ ...fields, domain: "spa ce.com" }), /domain is invalid/);
  assert.throws(() => siws.buildSiwsMessage({ ...fields, nonce: "xyz" }), /nonce is invalid/);
  assert.throws(() => siws.buildSiwsMessage({ ...fields, walletAddress: "0xdeadbeef" }), /wallet address is invalid/);
  assert.throws(() => siws.buildSiwsMessage({ ...fields, expiresAtMs: fields.issuedAtMs }), /expiry must come after/);
});

test("PoolPosition decoding matches the on-chain layout byte for byte", async () => {
  const [{ decodePoolPositionAccount, formatAtomsDecimal, POOL_POSITION_DISCRIMINATOR, POOL_POSITION_ACCOUNT_SIZE }, web3, idlRaw] = await Promise.all([
    import(new URL("app/lib/pool-position.ts", root)),
    import("@solana/web3.js"),
    readFile(new URL("vsol/target/idl/vsol.json", root), "utf8"),
  ]);
  const idl = JSON.parse(idlRaw);

  // The hardcoded discriminator must stay in lockstep with the published IDL.
  const published = idl.accounts.find((account) => account.name === "PoolPosition").discriminator;
  assert.deepEqual([...POOL_POSITION_DISCRIMINATOR], published);
  assert.equal(POOL_POSITION_ACCOUNT_SIZE, 262);

  const pubkeyFromByte = (byte) => new web3.PublicKey(Buffer.alloc(32, byte));
  const buffer = Buffer.alloc(262);
  Buffer.from(published).copy(buffer, 0);
  buffer[8] = 254; // bump
  buffer[9] = 253; // vault bump
  buffer[10] = 1; // status: Open
  buffer[11] = 1; // direction: down
  pubkeyFromByte(2).toBuffer().copy(buffer, 12); // pool
  pubkeyFromByte(3).toBuffer().copy(buffer, 44); // market
  pubkeyFromByte(4).toBuffer().copy(buffer, 76); // nonce record
  pubkeyFromByte(5).toBuffer().copy(buffer, 108); // buyer
  pubkeyFromByte(6).toBuffer().copy(buffer, 140); // quote authority
  pubkeyFromByte(7).toBuffer().copy(buffer, 172); // settlement mint
  buffer.writeBigUInt64LE(123456789n, 204); // nonce
  buffer.writeBigUInt64LE(171_250_000n, 212); // strike ($171.25 at 1e6)
  buffer.writeBigUInt64LE(12_500_000n, 220); // width
  buffer.writeBigUInt64LE(87_650_000n, 228); // premium
  buffer.writeBigUInt64LE(1_000_000_000n, 236); // max payout
  buffer.writeUInt16LE(150, 244); // fee bps
  buffer.writeBigInt64LE(1_784_600_000n, 246); // opened at
  buffer.writeBigInt64LE(1_786_996_440n, 254); // quote expiry

  const decoded = decodePoolPositionAccount(buffer);
  assert.equal(decoded.status, 1);
  assert.equal(decoded.direction, "down");
  assert.equal(decoded.pool.toBase58(), pubkeyFromByte(2).toBase58());
  assert.equal(decoded.market.toBase58(), pubkeyFromByte(3).toBase58());
  assert.equal(decoded.nonceRecord.toBase58(), pubkeyFromByte(4).toBase58());
  assert.equal(decoded.buyer.toBase58(), pubkeyFromByte(5).toBase58());
  assert.equal(decoded.quoteAuthority.toBase58(), pubkeyFromByte(6).toBase58());
  assert.equal(decoded.settlementMint.toBase58(), pubkeyFromByte(7).toBase58());
  assert.equal(decoded.nonce, 123456789n);
  assert.equal(decoded.strike, 171_250_000n);
  assert.equal(decoded.width, 12_500_000n);
  assert.equal(decoded.premium, 87_650_000n);
  assert.equal(decoded.maxPayout, 1_000_000_000n);
  assert.equal(decoded.feeBps, 150);
  assert.equal(decoded.openedAt, 1_784_600_000);
  assert.equal(decoded.quoteExpiry, 1_786_996_440);

  assert.equal(formatAtomsDecimal(171_250_000n), "171.25");
  assert.equal(formatAtomsDecimal(1_000_000_000n), "1000");

  assert.throws(() => decodePoolPositionAccount(buffer.subarray(0, 261)), /size is invalid/);
  const wrongDiscriminator = Buffer.from(buffer);
  wrongDiscriminator[0] ^= 0xff;
  assert.throws(() => decodePoolPositionAccount(wrongDiscriminator), /discriminator is invalid/);
  const badDirection = Buffer.from(buffer);
  badDirection[11] = 9;
  assert.throws(() => decodePoolPositionAccount(badDirection), /direction is invalid/);
});

test("launch series parameters stay on the NYSE grid and bind the deterministic market id", async () => {
  const [launch, expiries, sdk] = await Promise.all([
    import(new URL("app/lib/launch-params.ts", root)),
    import(new URL("app/lib/expiries.ts", root)),
    import(new URL("vsol/sdk/index.ts", root)),
  ]);

  const now = Date.parse("2026-07-17T14:00:00Z"); // regular NYSE session
  for (const code of ["7D", "30D"]) {
    const params = launch.deriveLaunchSeriesParams(code, "NVDA", now);
    const definition = expiries.resolveExpiry(code, "NVDA", now);
    assert.equal(params.expiry, Math.floor(definition.expiryAt / 1_000), `${code} expiry sits on the grid`);
    assert.equal(params.lastTradeAt, params.expiry - definition.tradeLockSeconds);
    assert.equal(params.observationWindowSeconds, 30);
    assert.equal(params.settlementGraceSeconds, 900);
    assert.equal(params.maxConfidenceBps, 500);
    assert.equal(params.priceScale, 1_000_000n);
    assert.equal(params.symbol, "NVDA");
  }

  // Grid params must hash to the same deterministic market id every time,
  // and any parameter change must move the id (Rust↔TS parity is covered in
  // the frozen SDK suite; this binds the launch flow to that derivation).
  const params = launch.deriveLaunchSeriesParams("30D", "NVDA", now);
  const settlementMint = new (await import("@solana/web3.js")).PublicKey("EaU6Yus9b7SWz3gzRNMuerpn1U9mYpfm996CQd2Lzhh4");
  const base = {
    pythFeedId: Buffer.from("b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593", "hex"),
    settlementMint,
    expiry: BigInt(params.expiry),
    observationWindowSeconds: params.observationWindowSeconds,
    settlementGraceSeconds: params.settlementGraceSeconds,
    priceScale: params.priceScale,
    maxConfidenceBps: params.maxConfidenceBps,
    symbol: sdk.symbolBytes(params.symbol),
  };
  const id = await sdk.deriveMarketId(base);
  assert.equal(id.length, 32);
  assert.deepEqual(await sdk.deriveMarketId(base), id);
  const differentExpiry = await sdk.deriveMarketId({ ...base, expiry: BigInt(params.expiry + 60) });
  assert.notDeepEqual(differentExpiry, id);

  // Intraday slots outside the session fail closed with the calendar reason.
  assert.throws(() => launch.deriveLaunchSeriesParams("15M", "NVDA", Date.parse("2026-07-18T14:00:00Z")), /session/i);

  // Pool risk limits mirror the program bounds.
  launch.validatePoolRiskLimits(8_000, 2_500);
  assert.throws(() => launch.validatePoolRiskLimits(0, 1), /risk limits/);
  assert.throws(() => launch.validatePoolRiskLimits(10_001, 100), /risk limits/);
  assert.throws(() => launch.validatePoolRiskLimits(5_000, 5_001), /risk limits/);
});

test("wallet-native auth surfaces exist and keep the audited patterns", async () => {
  const [nonceRoute, verifyRoute, sessionRoute, signoutRoute, sessionLib, chainRoute, launchPrepare, launchSend, terminal, schema] = await Promise.all([
    readFile(new URL("app/api/auth/nonce/route.ts", root), "utf8"),
    readFile(new URL("app/api/auth/verify/route.ts", root), "utf8"),
    readFile(new URL("app/api/auth/session/route.ts", root), "utf8"),
    readFile(new URL("app/api/auth/signout/route.ts", root), "utf8"),
    readFile(new URL("app/lib/session.ts", root), "utf8"),
    readFile(new URL("app/api/positions/chain/route.ts", root), "utf8"),
    readFile(new URL("app/api/vsol/launch/prepare/route.ts", root), "utf8"),
    readFile(new URL("app/api/vsol/launch/send/route.ts", root), "utf8"),
    readFile(new URL("app/components/TendTerminal.tsx", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
  ]);

  assert.match(nonceRoute, /sameOrigin/);
  assert.match(nonceRoute, /crypto\.getRandomValues/);
  assert.match(verifyRoute, /nacl\.sign\.detached\.verify/);
  assert.match(verifyRoute, /siwsMessageBytes/);
  assert.match(verifyRoute, /isNull\(authNonces\.usedAt\)/, "nonce single-use is enforced atomically");
  assert.match(verifyRoute, /Set-Cookie/);
  assert.match(sessionRoute, /readSessionWallet/);
  assert.match(signoutRoute, /signOutCookie/);
  assert.match(sessionLib, /SESSION_SECRET/);
  assert.match(sessionLib, /wallet:\$\{wallet\}/, "session wallet is the primary user key");
  assert.match(sessionLib, /getChatGPTUser/, "ChatGPT header identity stays as optional alternate");
  assert.match(chainRoute, /readSessionWallet/);
  assert.match(chainRoute, /describeRpcFailure/);
  assert.doesNotMatch(chainRoute, /resolveUserKey/, "chain reads require the wallet session, not weaker fallbacks");
  assert.match(launchPrepare, /transactionMessageHash|messageHash/);
  assert.match(launchSend, /sigVerify: true/);
  assert.match(launchSend, /verifyPostState/);
  assert.match(terminal, /establishWalletSession/);
  assert.match(terminal, /LaunchView/);
  assert.match(schema, /auth_nonces/);
  assert.match(schema, /launch_actions/);
});
