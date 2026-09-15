"use client";

// Shared chain-position data layer. Both PortfolioView (the Portfolio tab)
// and TradePositionsPanel (the Trade page's bottom panel) render open
// positions straight from the verified VSOL program via
// `/api/positions/chain`, and neither may compute that money figure a
// different way -- this hook is the single place that fetch and its
// loading/signin-required/error/ready state machine lives, so the two
// surfaces can never drift.

import { useCallback, useEffect, useState } from "react";

export type ChainPositionRow = {
  address: string;
  pool: string;
  market: string;
  direction: "up" | "down";
  status: "open" | "unknown";
  strike: string;
  cap: string;
  premium: string;
  maxPayout: string;
  premiumAtoms: string;
  maxPayoutAtoms: string;
  openedAt: number;
  symbol: string | null;
  seriesCode: string | null;
  marketExpiry: number | null;
  provenance: {
    transactionSignature: string | null;
    simulationId: string | null;
    simulationLogsHash: string | null;
  } | null;
};

export type ChainState =
  | { phase: "loading" }
  | { phase: "signin-required"; message: string }
  | { phase: "error"; message: string }
  | { phase: "ready"; positions: ChainPositionRow[]; checkedAt: string };

export function useChainPositions(walletAddress: string, sessionWallet: string | null): { state: ChainState; reload: () => Promise<void> } {
  const [chain, setChain] = useState<ChainState>({ phase: "loading" });

  const loadChain = useCallback(async () => {
    setChain({ phase: "loading" });
    try {
      const response = await fetch("/api/positions/chain", { cache: "no-store" });
      const result = await response.json() as {
        positions?: ChainPositionRow[];
        checkedAt?: string;
        error?: string;
        code?: string;
      };
      if (response.status === 401 || result.code === "WALLET_SESSION_REQUIRED") {
        setChain({ phase: "signin-required", message: result.error ?? "Sign in with your wallet signature to read chain positions." });
        return;
      }
      if (!response.ok || !result.positions) {
        setChain({ phase: "error", message: result.error ?? "Chain positions are unavailable." });
        return;
      }
      setChain({ phase: "ready", positions: result.positions, checkedAt: result.checkedAt ?? new Date().toISOString() });
    } catch {
      setChain({ phase: "error", message: "Chain positions are unreachable. Check your connection and retry." });
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadChain(), 0);
    return () => window.clearTimeout(initial);
  }, [loadChain, sessionWallet]);

  return { state: chain, reload: loadChain };
}
