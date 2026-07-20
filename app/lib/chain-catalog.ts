// Chain-derived market and pool discovery. The verified manifest series stay
// the only quotable instruments; everything else found on-chain is surfaced
// read-only with an explicit tradability note, never invented as executable.

import { Connection } from "@solana/web3.js";
import { VSOL_LIQUIDITY, VSOL_PROGRAM_ID, VSOL_SERIES } from "./vsol";
import {
  decodeMarketAccount,
  decodePoolAccount,
  decodePoolMarketAccount,
  getVsolConnection,
} from "./vsol-server";

const MARKET_ACCOUNT_SIZE = 277;
const POOL_ACCOUNT_SIZE = 214;
const POOL_MARKET_ACCOUNT_SIZE = 82;

export type DiscoveredMarket = {
  address: string;
  marketId: string;
  symbol: string;
  expiry: number;
  observationWindowSeconds: number;
  settlementGraceSeconds: number;
  maxConfidenceBps: number;
  pythFeedId: string;
  enabled: boolean;
  creator: string;
  verified: boolean;
  tradable: boolean;
  tradabilityNote: string;
};

export type CatalogPool = {
  address: string;
  label: string;
  manager: string;
  quoteAuthority: string;
  settlementMint: string;
  maxUtilizationBps: number;
  maxPositionBps: number;
  openPositions: number;
  quotable: boolean;
  authorizedMarkets: string[];
};

export type VsolChainCatalog = {
  discovered: DiscoveredMarket[];
  pools: CatalogPool[];
};

export async function getVsolChainCatalog(connection: Connection = getVsolConnection()): Promise<VsolChainCatalog> {
  const [marketAccounts, poolAccounts, poolMarketAccounts] = await Promise.all([
    connection.getProgramAccounts(VSOL_PROGRAM_ID, { commitment: "confirmed", filters: [{ dataSize: MARKET_ACCOUNT_SIZE }] }),
    connection.getProgramAccounts(VSOL_PROGRAM_ID, { commitment: "confirmed", filters: [{ dataSize: POOL_ACCOUNT_SIZE }] }),
    connection.getProgramAccounts(VSOL_PROGRAM_ID, { commitment: "confirmed", filters: [{ dataSize: POOL_MARKET_ACCOUNT_SIZE }] }),
  ]);

  const authorizations = new Map<string, string[]>();
  for (const { account } of poolMarketAccounts) {
    try {
      const poolMarket = decodePoolMarketAccount(Buffer.from(account.data));
      if (!poolMarket.enabled) continue;
      const pool = poolMarket.pool.toBase58();
      authorizations.set(pool, [...(authorizations.get(pool) ?? []), poolMarket.market.toBase58()]);
    } catch {
      // Not a pool-market account; sizes are unique per type today, but decoding stays defensive.
    }
  }

  const manifestPool = VSOL_LIQUIDITY?.poolKey.toBase58() ?? null;
  const pools: CatalogPool[] = [];
  for (const { pubkey, account } of poolAccounts) {
    try {
      const pool = decodePoolAccount(Buffer.from(account.data));
      const address = pubkey.toBase58();
      const quotable = address === manifestPool;
      pools.push({
        address,
        label: quotable ? "Tend pool" : `Pool ${address.slice(0, 4)}…${address.slice(-4)}`,
        manager: pool.manager.toBase58(),
        quoteAuthority: pool.quoteAuthority.toBase58(),
        settlementMint: pool.settlementMint.toBase58(),
        maxUtilizationBps: pool.maxUtilizationBps,
        maxPositionBps: pool.maxPositionBps,
        openPositions: Number(pool.openPositions),
        quotable,
        authorizedMarkets: authorizations.get(address) ?? [],
      });
    } catch {
      // Skip undecodable accounts instead of failing the whole catalog.
    }
  }
  pools.sort((left, right) => Number(right.quotable) - Number(left.quotable) || left.address.localeCompare(right.address));

  const manifestMarkets = new Set(VSOL_SERIES.map((series) => series.marketKey.toBase58()));
  const tendAuthorized = new Set(manifestPool ? authorizations.get(manifestPool) ?? [] : []);
  const discovered: DiscoveredMarket[] = [];
  for (const { pubkey, account } of marketAccounts) {
    try {
      const market = decodeMarketAccount(Buffer.from(account.data));
      const address = pubkey.toBase58();
      const verified = manifestMarkets.has(address);
      if (verified) continue; // The verified manifest series ship separately with full state checks.
      const authorizedAnywhere = pools.some((pool) => pool.authorizedMarkets.includes(address));
      discovered.push({
        address,
        marketId: Buffer.from(market.marketId).toString("hex"),
        symbol: market.symbol || "UNKNOWN",
        expiry: market.expiry,
        observationWindowSeconds: market.observationWindowSeconds,
        settlementGraceSeconds: market.settlementGraceSeconds,
        maxConfidenceBps: market.maxConfidenceBps,
        pythFeedId: market.pythFeedId,
        enabled: market.enabled,
        creator: market.creator.toBase58(),
        verified: false,
        tradable: tendAuthorized.has(address),
        tradabilityNote: tendAuthorized.has(address)
          ? "Authorized by the Tend pool."
          : authorizedAnywhere
            ? "Authorized by another pool; no quote service is integrated for it yet."
            : "Read-only until a liquidity pool manager authorizes this series.",
      });
    } catch {
      // Skip undecodable accounts.
    }
  }
  discovered.sort((left, right) => left.expiry - right.expiry);

  return { discovered, pools };
}
