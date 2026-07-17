import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the Tend trading surface and real Robinhood token addresses", async () => {
  const [page, terminal, markets] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/components/TendTerminal.tsx", root), "utf8"),
    readFile(new URL("app/lib/markets.ts", root), "utf8"),
  ]);

  assert.match(page, /TendTerminal/);
  assert.match(terminal, /Request live quotes/);
  assert.match(terminal, /Maximum loss/);
  assert.match(terminal, /100% locked/);
  assert.match(terminal, /Preview mark · not live/);
  assert.match(markets, /0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC/);
  assert.match(markets, /0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa/);
});

test("contract guards collateral, signatures, replay, pause, and eligibility", async () => {
  const source = await readFile(new URL("contracts/TendMarket.sol", root), "utf8");
  assert.match(source, /EIP712Domain/);
  assert.match(source, /filledQuotes\[digest\]/);
  assert.match(source, /cancelledNonces/);
  assert.match(source, /eligibility\.canTrade/);
  assert.match(source, /approvedUnderlyings\[quote\.underlying\]/);
  assert.match(source, /approvedCollateralTokens\[quote\.collateralToken\]/);
  assert.match(source, /_safeTransferFromExact\(quote\.collateralToken, quote\.maker, address\(this\), quote\.maxPayout\)/);
  assert.match(source, /function settle/);
  assert.doesNotMatch(source, /function settle[\s\S]{0,100}if \(paused\)/);
});

test("server owns executable RFQs and persists consumed positions", async () => {
  const [quotesRoute, positionsRoute, schema, hosting] = await Promise.all([
    readFile(new URL("app/api/quotes/route.ts", root), "utf8"),
    readFile(new URL("app/api/positions/route.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
  ]);

  assert.match(quotesRoute, /insert\(rfqQuotes\)/);
  assert.match(positionsRoute, /quote\.consumedAt/);
  assert.match(positionsRoute, /db\.batch/);
  assert.match(schema, /uniqueIndex\("positions_quote_unique_idx"\)/);
  assert.match(hosting, /"d1": "DB"/);
});
