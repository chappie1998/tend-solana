import "../../../lib/runtime-env-worker";
import { json, readSessionWallet } from "../../../lib/session";

export async function GET(request: Request) {
  const wallet = await readSessionWallet(request);
  return json({ wallet }, 200, { "Cache-Control": "private, no-store" });
}
