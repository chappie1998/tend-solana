import { SYSVAR_CLOCK_PUBKEY, type AccountInfo, type Connection } from "@solana/web3.js";

const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";

export function decodeClockUnixTimestamp(account: AccountInfo<Buffer> | null): number {
  if (!account || account.data.length !== 40 || account.owner.toBase58() !== SYSVAR_OWNER) {
    throw new Error("Solana Clock sysvar is unavailable or invalid");
  }
  return Number(Buffer.from(account.data).readBigInt64LE(32));
}

export async function getClockUnixTimestamp(connection: Connection): Promise<number> {
  return decodeClockUnixTimestamp(await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed"));
}
