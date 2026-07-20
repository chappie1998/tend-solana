import "../../../lib/runtime-env-worker";
import { json, sameOrigin, signOutCookie } from "../../../lib/session";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Cross-site sign-out requests are not allowed." }, 403);
  return json({ ok: true }, 200, { "Set-Cookie": signOutCookie(request), "Cache-Control": "private, no-store" });
}
