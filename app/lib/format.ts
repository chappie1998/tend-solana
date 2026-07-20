// Shared display formatting for token atom amounts (previously duplicated in
// EarnView and the status route).

export function formatAtoms(value: string | undefined, decimals = 6, maximumFractionDigits = 2) {
  if (!value || !/^\d+$/.test(value)) return "—";
  const padded = value.padStart(decimals + 1, "0");
  const integer = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).slice(0, maximumFractionDigits).replace(/0+$/, "");
  return `${BigInt(integer).toLocaleString()}${fraction ? `.${fraction}` : ""}`;
}
