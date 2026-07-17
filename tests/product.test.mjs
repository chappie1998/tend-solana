import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the Tend trading surface and real Robinhood token addresses", async () => {
  const [page, terminal, markets, chart] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/components/TendTerminal.tsx", root), "utf8"),
    readFile(new URL("app/lib/markets.ts", root), "utf8"),
    readFile(new URL("app/components/TradingViewMarketChart.tsx", root), "utf8"),
  ]);

  assert.match(page, /TendTerminal/);
  assert.match(terminal, /Request live quotes/);
  assert.match(terminal, /Maximum loss/);
  assert.match(terminal, /100% locked/);
  assert.match(terminal, /Chart feed is display-only/);
  assert.match(terminal, /US reference session only/);
  assert.match(chart, /lightweight-charts/);
  assert.match(chart, /Charts by TradingView/);
  assert.match(chart, /DEMO DATA/);
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
  assert.match(source, /quote\.observationWindow < 30/);
  assert.match(source, /quoteWindowOpen\(quote\.expiry, quote\.deadline, quote\.tradeLock\)/);
  assert.match(source, /observedFrom != position\.expiry/);
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
  assert.match(quotesRoute, /resolveExpiry\(expiryCode, symbol, requestedAt\)/);
  assert.match(quotesRoute, /freshIntradayReference\(market\)/);
  assert.match(quotesRoute, /Intraday quotes require a fresh licensed reference feed/);
  assert.match(positionsRoute, /quote\.consumedAt/);
  assert.match(positionsRoute, /db\.batch/);
  assert.match(schema, /uniqueIndex\("positions_quote_unique_idx"\)/);
  assert.match(schema, /observationWindowSeconds/);
  assert.match(hosting, /"d1": "DB"/);
});

test("market data is sourced through a server adapter and never silently presented as live", async () => {
  const [marketData, expiries] = await Promise.all([
    readFile(new URL("app/api/market-data/route.ts", root), "utf8"),
    readFile(new URL("app/lib/expiries.ts", root), "utf8"),
  ]);

  assert.match(marketData, /process\.env\.MASSIVE_API_KEY/);
  assert.match(marketData, /Tend simulated market data/);
  assert.match(marketData, /never used for settlement/);
  assert.match(expiries, /"15M" \| "1H" \| "EOD" \| "7D" \| "30D"/);
  assert.match(expiries, /symbol !== "SPCX"/);
  assert.match(expiries, /tradeLockSeconds/);
});

test("intraday expiry rules open only during the reference session and exclude SPCX", async () => {
  const [{ resolveExpiry }, { quoteFor }] = await Promise.all([
    import(new URL("app/lib/expiries.ts", root)),
    import(new URL("app/lib/options.ts", root)),
  ]);
  const regularSession = Date.parse("2026-07-17T14:00:00Z");
  const closedSession = Date.parse("2026-07-17T03:00:00Z");
  const intraday = resolveExpiry("15M", "NVDA", regularSession);

  assert.equal(intraday.available, true);
  assert.equal(intraday.durationMinutes, 15);
  assert.equal(intraday.observationWindowSeconds, 60);
  assert.equal(resolveExpiry("15M", "NVDA", closedSession).available, false);
  assert.equal(resolveExpiry("15M", "SPCX", regularSession).available, false);

  const shortPremium = quoteFor({ spot: 100, amount: 10_000, durationMinutes: 15, direction: "up", payoff: 5, volatility: 45 }).premium;
  const weeklyPremium = quoteFor({ spot: 100, amount: 10_000, durationMinutes: 10_080, direction: "up", payoff: 5, volatility: 45 }).premium;
  assert.ok(shortPremium < weeklyPremium);
});
