// Chain-derived portfolio: reads a wallet's PoolPosition accounts directly
// from the verified VSOL program, so the portfolio renders for any wallet
// with zero database rows. The DB remains a provenance cache only.

import { Connection, PublicKey } from "@solana/web3.js";
import { VSOL_PROGRAM_ID, VSOL_SERIES } from "./vsol";
import { decodeMarketAccount, getVsolConnection } from "./vsol-server";
import {
  POOL_POSITION_ACCOUNT_SIZE,
  POOL_POSITION_BUYER_OFFSET,
  POOL_POSITION_STATUS_OPEN,
  decodePoolPositionAccount,
  formatAtomsDecimal,
} from "./pool-position";

export type ChainPosition = {
  address: string;
  pool: string;
  market: string;
  buyer: string;
  quoteAuthority: string;
  settlementMint: string;
  direction: "up" | "down";
  status: "open" | "unknown";
  nonce: string;
  strike: string;
  width: string;
  cap: string;
  premium: string;
  maxPayout: string;
  premiumAtoms: string;
  maxPayoutAtoms: string;
  feeBps: number;
  openedAt: number;
  quoteExpiry: number;
  symbol: string | null;
  seriesCode: string | null;
  marketExpiry: number | null;
  marketEnabled: boolean | null;
};

function priceDecimals(priceScale: bigint) {
  // Every published market uses a power-of-ten scale; anything else renders
  // conservatively at 6 decimals rather than inventing a conversion.
  const text = priceScale.toString();
  return /^10*$/.test(text) ? text.length - 1 : 6;
}

export async function getChainPositions(buyer: PublicKey, connection: Connection = getVsolConnection()) {
  const accounts = await connection.getProgramAccounts(VSOL_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { dataSize: POOL_POSITION_ACCOUNT_SIZE },
      { memcmp: { offset: POOL_POSITION_BUYER_OFFSET, bytes: buyer.toBase58() } },
    ],
  });

  const decoded = accounts.map(({ pubkey, account }) => ({
    address: pubkey,
    position: decodePoolPositionAccount(Buffer.from(account.data)),
  }));
  for (const entry of decoded) {
    if (!entry.position.buyer.equals(buyer)) {
      throw new Error("A returned pool position does not belong to the requested wallet");
    }
  }

  const marketAddresses = [...new Set(decoded.map((entry) => entry.position.market.toBase58()))];
  const marketInfo = new Map<string, ReturnType<typeof decodeMarketAccount>>();
  if (marketAddresses.length) {
    const infos = await connection.getMultipleAccountsInfo(
      marketAddresses.map((address) => new PublicKey(address)),
      "confirmed",
    );
    infos.forEach((info, index) => {
      if (!info || !info.owner.equals(VSOL_PROGRAM_ID)) return;
      try {
        marketInfo.set(marketAddresses[index], decodeMarketAccount(Buffer.from(info.data)));
      } catch {
        // Unknown layout: render the position without market metadata.
      }
    });
  }

  return decoded
    .map(({ address, position }): ChainPosition => {
      const market = marketInfo.get(position.market.toBase58()) ?? null;
      const series = VSOL_SERIES.find((entry) => entry.marketKey.equals(position.market)) ?? null;
      const scaleDecimals = market ? priceDecimals(market.priceScale) : 6;
      const settlementDecimals = market?.settlementDecimals ?? 6;
      return {
        address: address.toBase58(),
        pool: position.pool.toBase58(),
        market: position.market.toBase58(),
        buyer: position.buyer.toBase58(),
        quoteAuthority: position.quoteAuthority.toBase58(),
        settlementMint: position.settlementMint.toBase58(),
        direction: position.direction,
        status: position.status === POOL_POSITION_STATUS_OPEN ? "open" : "unknown",
        nonce: position.nonce.toString(),
        strike: formatAtomsDecimal(position.strike, scaleDecimals),
        width: formatAtomsDecimal(position.width, scaleDecimals),
        cap: formatAtomsDecimal(
          position.direction === "up"
            ? position.strike + position.width
            : position.strike > position.width ? position.strike - position.width : 0n,
          scaleDecimals,
        ),
        premium: formatAtomsDecimal(position.premium, settlementDecimals),
        maxPayout: formatAtomsDecimal(position.maxPayout, settlementDecimals),
        premiumAtoms: position.premium.toString(),
        maxPayoutAtoms: position.maxPayout.toString(),
        feeBps: position.feeBps,
        openedAt: position.openedAt,
        quoteExpiry: position.quoteExpiry,
        symbol: market?.symbol ?? series?.symbol ?? null,
        seriesCode: series?.code ?? null,
        marketExpiry: market?.expiry ?? series?.expiry ?? null,
        marketEnabled: market?.enabled ?? null,
      };
    })
    .sort((left, right) => right.openedAt - left.openedAt);
}
