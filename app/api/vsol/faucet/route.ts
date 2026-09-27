import "../../../lib/runtime-env-worker";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getVsolConnection, parsePublicKey, vsolFaucet } from "../../../lib/vsol-server";
import { VSOL_SETTLEMENT_MINT } from "../../../lib/vsol";
import { resolveUserKey, sameOrigin } from "../../../lib/session";
import { enforceInMemoryRateLimit } from "../../../lib/in-memory-rate-limit";

const TARGET_TOKENS = 25_000n * 1_000_000n;
const TARGET_LAMPORTS = 20_000_000;

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-site faucet requests are not allowed." }, { status: 403 });
  const owner = await resolveUserKey(request);
  if (!owner) return Response.json({ error: "Sign in to use the devnet faucet." }, { status: 401 });
  // Best-effort burst dampener only -- mints real devnet SOL/tokens, the most
  // directly costly route this file protects. See
  // app/lib/in-memory-rate-limit.ts's doc comment for why this alone is not
  // sufficient (per-instance, resets on redeploy, IP is spoofable).
  const rateLimit = enforceInMemoryRateLimit(request, "faucet", owner);
  if (rateLimit.limited) {
    return Response.json(
      { error: "Too many faucet requests. Wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }
  const input = await request.json().catch(() => null) as { walletAddress?: unknown } | null;
  const wallet = parsePublicKey(input?.walletAddress);
  if (!wallet) return Response.json({ error: "Connect a valid Solana wallet first." }, { status: 422 });

  try {
    const connection = getVsolConnection();
    const faucet = vsolFaucet();
    const mint = await getMint(connection, VSOL_SETTLEMENT_MINT, "confirmed", TOKEN_PROGRAM_ID);
    if (!mint.mintAuthority?.equals(faucet.publicKey)) throw new Error("Faucet is not the mock mint authority");
    const tokenAccount = getAssociatedTokenAddressSync(VSOL_SETTLEMENT_MINT, wallet);
    const transaction = new Transaction();
    const existing = await connection.getAccountInfo(tokenAccount, "confirmed");
    let tokenBalance = 0n;
    if (!existing) {
      transaction.add(createAssociatedTokenAccountInstruction(faucet.publicKey, tokenAccount, wallet, VSOL_SETTLEMENT_MINT));
    } else {
      tokenBalance = (await getAccount(connection, tokenAccount, "confirmed", TOKEN_PROGRAM_ID)).amount;
    }
    if (tokenBalance < TARGET_TOKENS) {
      transaction.add(createMintToInstruction(VSOL_SETTLEMENT_MINT, tokenAccount, faucet.publicKey, TARGET_TOKENS - tokenBalance));
    }
    const solBalance = await connection.getBalance(wallet, "confirmed");
    if (solBalance < TARGET_LAMPORTS) {
      transaction.add(SystemProgram.transfer({
        fromPubkey: faucet.publicKey,
        toPubkey: wallet,
        lamports: TARGET_LAMPORTS - solBalance,
      }));
    }
    const signature = transaction.instructions.length
      ? await sendAndConfirmTransaction(connection, transaction, [faucet], { commitment: "confirmed" })
      : null;
    return Response.json({
      ok: true,
      tokenAccount: tokenAccount.toBase58(),
      mockUsdc: Number(TARGET_TOKENS) / 1_000_000,
      sol: TARGET_LAMPORTS / LAMPORTS_PER_SOL,
      signature,
    });
  } catch {
    return Response.json({ error: "The devnet faucet is temporarily unavailable." }, { status: 503 });
  }
}
