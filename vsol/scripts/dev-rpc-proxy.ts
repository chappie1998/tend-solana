import { createServer } from "node:http";

const upstream = process.env.VSOL_PROXY_UPSTREAM ?? "https://api.devnet.solana.com";
const port = Number(process.env.VSOL_PROXY_PORT ?? 8898);

createServer(async (request, response) => {
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  try {
    const upstreamResponse = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.concat(chunks),
    });
    response.writeHead(upstreamResponse.status, { "content-type": "application/json" });
    response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "proxy failure" }));
  }
}).listen(port, "127.0.0.1", () => console.log(`VSOL dev RPC proxy listening on http://127.0.0.1:${port}`));
