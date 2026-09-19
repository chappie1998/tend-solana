import { Connection, PublicKey } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("2SgyYptw5rMFsTKHiP95c5K3porxFrcsz6fb4mBfDa1v");
const DISCRIMINATOR = Buffer.from([246, 13, 238, 156, 119, 129, 253, 135]);
const rpc = process.env.VSOL_RPC_URL || "https://api.devnet.solana.com";
const connection = new Connection(rpc, "confirmed");

function decodePosition(pubkey, data) {
  let o = 8;
  const bump = data.readUInt8(o); o += 1;
  const vaultBump = data.readUInt8(o); o += 1;
  const status = data.readUInt8(o); o += 1;
  const direction = data.readUInt8(o); o += 1;
  const pool = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const market = new PublicKey(data.subarray(o, o + 32)); o += 32;
  o += 32; // nonce_record
  const buyer = new PublicKey(data.subarray(o, o + 32)); o += 32;
  o += 32; // quote_authority
  o += 32; // settlement_mint
  const nonce = data.readBigUInt64LE(o); o += 8;
  const strike = data.readBigUInt64LE(o); o += 8;
  const width = data.readBigUInt64LE(o); o += 8;
  const premium = data.readBigUInt64LE(o); o += 8;
  const maxPayout = data.readBigUInt64LE(o); o += 8;
  const feeBps = data.readUInt16LE(o); o += 2;
  const openedAt = data.readBigInt64LE(o); o += 8;
  const quoteExpiry = data.readBigInt64LE(o); o += 8;
  return { pubkey, bump, vaultBump, status, direction, pool: pool.toBase58(), market: market.toBase58(), buyer: buyer.toBase58(), nonce, strike, width, premium, maxPayout, feeBps, openedAt, quoteExpiry };
}

const fmtUsd = (atoms) => (Number(atoms) / 1_000_000).toFixed(6);
const fmtTs = (ts) => new Date(Number(ts) * 1000).toISOString();

const seen = new Map();

async function scan() {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: Buffer.from(DISCRIMINATOR).toString("base64"), encoding: "base64" } }],
  });
  const current = new Map();
  for (const { pubkey, account } of accounts) {
    const pos = decodePosition(pubkey.toBase58(), account.data);
    current.set(pos.pubkey, pos);
  }
  for (const [key, pos] of current) {
    if (!seen.has(key)) {
      console.log(`[${new Date().toISOString()}] NEW POSITION ${key}`);
      console.log(`  buyer=${pos.buyer} market=${pos.market} direction=${pos.direction === 0 ? "UP" : "DOWN"}`);
      console.log(`  strike=$${fmtUsd(pos.strike)} width=$${fmtUsd(pos.width)} premium=$${fmtUsd(pos.premium)} maxPayout=$${fmtUsd(pos.maxPayout)} feeBps=${pos.feeBps}`);
      console.log(`  opened=${fmtTs(pos.openedAt)} status=${pos.status}`);
    } else {
      const prev = seen.get(key);
      if (prev.status !== pos.status) {
        console.log(`[${new Date().toISOString()}] POSITION ${key} status changed ${prev.status} -> ${pos.status}`);
      }
    }
  }
  for (const [key, pos] of seen) {
    if (!current.has(key)) {
      console.log(`[${new Date().toISOString()}] POSITION CLOSED/SETTLED ${key} (buyer=${pos.buyer}, was status=${pos.status})`);
    }
  }
  seen.clear();
  for (const [k, v] of current) seen.set(k, v);
}

console.log(`Watching PoolPosition accounts on ${rpc} every 10s...`);
await scan();
setInterval(() => { scan().catch((e) => console.error("scan error:", e.message)); }, 10_000);
