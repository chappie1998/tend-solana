// Sign-In-With-Solana canonical message. Pure module shared by the browser
// (builds the message the wallet signs) and the server (rebuilds the exact
// same bytes before verifying the ed25519 signature). Any drift between the
// two sides is a hard authentication failure, so all inputs are validated
// strictly and the output format is versioned.

const BASE58_WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NONCE_HEX = /^[0-9a-f]{64}$/;
// Host[:port] only. Anything with whitespace or newlines could smuggle
// extra statement lines into the signed message.
const DOMAIN_PATTERN = /^[a-z0-9.-]+(:\d{1,5})?$/i;

export const SIWS_VERSION = "1";
export const SIWS_STATEMENT =
  "Sign in to Tend. This signature only proves wallet ownership; it authorizes no transaction and moves no funds.";

export type SiwsFields = {
  domain: string;
  walletAddress: string;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

export function validateSiwsFields(fields: SiwsFields) {
  if (typeof fields.domain !== "string" || !DOMAIN_PATTERN.test(fields.domain)) {
    throw new Error("The sign-in domain is invalid");
  }
  if (typeof fields.walletAddress !== "string" || !BASE58_WALLET.test(fields.walletAddress)) {
    throw new Error("The sign-in wallet address is invalid");
  }
  if (typeof fields.nonce !== "string" || !NONCE_HEX.test(fields.nonce)) {
    throw new Error("The sign-in nonce is invalid");
  }
  if (!Number.isSafeInteger(fields.issuedAtMs) || fields.issuedAtMs <= 0) {
    throw new Error("The sign-in issue time is invalid");
  }
  if (!Number.isSafeInteger(fields.expiresAtMs) || fields.expiresAtMs <= fields.issuedAtMs) {
    throw new Error("The sign-in expiry must come after the issue time");
  }
}

export function buildSiwsMessage(fields: SiwsFields) {
  validateSiwsFields(fields);
  return [
    `${fields.domain} wants you to sign in with your Solana account:`,
    fields.walletAddress,
    "",
    SIWS_STATEMENT,
    "",
    `Domain: ${fields.domain}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${new Date(fields.issuedAtMs).toISOString()}`,
    `Expiration Time: ${new Date(fields.expiresAtMs).toISOString()}`,
    `Version: ${SIWS_VERSION}`,
  ].join("\n");
}

export function siwsMessageBytes(fields: SiwsFields) {
  return new TextEncoder().encode(buildSiwsMessage(fields));
}
