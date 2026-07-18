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
import { VSOL_CONNECTION, parsePublicKey, vsolFaucet } from "../../../lib/vsol-server";
import { VSOL_SETTLEMENT_MINT } from "../../../lib/vsol";
import { getChatGPTUser } from "../../../chatgpt-auth";

const TARGET_TOKENS = 25_000n * 1_000_000n;
const TARGET_LAMPORTS = 20_000_000;

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function authorized(request: Request) {
  if (await getChatGPTUser()) return true;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-site faucet requests are not allowed." }, { status: 403 });
  if (!(await authorized(request))) return Response.json({ error: "Sign in to use the devnet faucet." }, { status: 401 });
  const input = await request.json().catch(() => null) as { walletAddress?: unknown } | null;
  const wallet = parsePublicKey(input?.walletAddress);
  if (!wallet) return Response.json({ error: "Connect a valid Solana wallet first." }, { status: 422 });

  try {
    const faucet = vsolFaucet();
    const mint = await getMint(VSOL_CONNECTION, VSOL_SETTLEMENT_MINT, "confirmed", TOKEN_PROGRAM_ID);
    if (!mint.mintAuthority?.equals(faucet.publicKey)) throw new Error("Faucet is not the mock mint authority");
    const tokenAccount = getAssociatedTokenAddressSync(VSOL_SETTLEMENT_MINT, wallet);
    const transaction = new Transaction();
    const existing = await VSOL_CONNECTION.getAccountInfo(tokenAccount, "confirmed");
    let tokenBalance = 0n;
    if (!existing) {
      transaction.add(createAssociatedTokenAccountInstruction(faucet.publicKey, tokenAccount, wallet, VSOL_SETTLEMENT_MINT));
    } else {
      tokenBalance = (await getAccount(VSOL_CONNECTION, tokenAccount, "confirmed", TOKEN_PROGRAM_ID)).amount;
    }
    if (tokenBalance < TARGET_TOKENS) {
      transaction.add(createMintToInstruction(VSOL_SETTLEMENT_MINT, tokenAccount, faucet.publicKey, TARGET_TOKENS - tokenBalance));
    }
    const solBalance = await VSOL_CONNECTION.getBalance(wallet, "confirmed");
    if (solBalance < TARGET_LAMPORTS) {
      transaction.add(SystemProgram.transfer({
        fromPubkey: faucet.publicKey,
        toPubkey: wallet,
        lamports: TARGET_LAMPORTS - solBalance,
      }));
    }
    const signature = transaction.instructions.length
      ? await sendAndConfirmTransaction(VSOL_CONNECTION, transaction, [faucet], { commitment: "confirmed" })
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
