import { and, desc, eq, isNull } from "drizzle-orm";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureDb, getDb } from "../../../db";
import { positions, rfqQuotes } from "../../../db/schema";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function isUniqueConstraint(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const candidate = current as { message?: unknown; cause?: unknown };
    if (String(candidate.message ?? current).toLowerCase().includes("unique constraint")) return true;
    current = candidate.cause;
  }
  return false;
}

async function userKey(request: Request) {
  const user = await getChatGPTUser();
  if (user?.email) return user.email;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "local-preview@tend.local" : null;
}

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  await ensureDb();
  const owner = await userKey(request);
  if (!owner) return json({ error: "Sign in to view positions." }, 401);
  const db = getDb();
  const rows = await db.select().from(positions).where(eq(positions.userEmail, owner)).orderBy(desc(positions.createdAt));
  return json({ positions: rows });
}

export async function POST(request: Request) {
  await ensureDb();
  if (!isSameOrigin(request)) return json({ error: "Cross-site position requests are not allowed." }, 403);
  const owner = await userKey(request);
  if (!owner) return json({ error: "Sign in to confirm positions." }, 401);
  let input: Record<string, unknown>;
  try {
    input = await request.json() as Record<string, unknown>;
  } catch {
    return json({ error: "The position request must be valid JSON." }, 400);
  }

  const walletAddress = typeof input.walletAddress === "string" ? input.walletAddress : "";
  const quoteId = typeof input.quoteId === "string" ? input.quoteId : "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) return json({ error: "Connect a valid EVM wallet first." }, 422);
  if (!quoteId) return json({ error: "Select an executable quote first." }, 422);

  const db = getDb();
  const [quote] = await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, quoteId)).limit(1);
  if (!quote) return json({ error: "The quote does not exist. Request a fresh price." }, 404);
  if (quote.consumedAt) return json({ error: "This quote has already been used." }, 409);
  if (quote.expiresAt.getTime() < Date.now()) return json({ error: "The quote has expired. Request a fresh price." }, 409);

  const consumedAt = new Date();
  const row = {
    id: crypto.randomUUID(),
    userEmail: owner,
    walletAddress,
    quoteId: quote.id,
    maker: quote.maker,
    symbol: quote.symbol,
    direction: quote.direction,
    amount: quote.amount,
    premium: quote.premium,
    strike: quote.strike,
    capPrice: quote.capPrice,
    expiryDays: quote.expiryDays,
    expiryCode: quote.expiryCode,
    optionExpiryAt: quote.optionExpiryAt,
    observationWindowSeconds: quote.observationWindowSeconds,
    tradeLockSeconds: quote.tradeLockSeconds,
    status: "preview_confirmed" as const,
    createdAt: consumedAt,
  };

  try {
    await db.batch([
      db.insert(positions).values(row),
      db.update(rfqQuotes).set({ consumedAt }).where(and(eq(rfqQuotes.id, quote.id), isNull(rfqQuotes.consumedAt))),
    ]);
  } catch (error) {
    if (isUniqueConstraint(error)) return json({ error: "This quote has already been used." }, 409);
    throw error;
  }
  return json({ position: row }, 201);
}
