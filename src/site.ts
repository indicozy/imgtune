import { isIP } from "node:net";

// ---------------------------------------------------------------------------------------------------------------------
// Same site: a page that ends on another URL is measured only when it stays on the same registrable domain
// ---------------------------------------------------------------------------------------------------------------------

/** Second-level labels that sit under a country code (co.uk, com.mx, ...). A small list, not the full public suffix list. */
const CC_SECOND_LEVEL = new Set(["ac", "co", "com", "edu", "gov", "go", "gob", "mil", "ne", "net", "nic", "or", "org"]);

/**
 * The registrable domain of a host name: its last two labels, or three under a country code with a second-level label
 * such as co.uk or com.mx. Hosts that are IP addresses, or have no dot, are their own domain.
 */
export function registrableDomain(host: string): string {
  const name = host.toLowerCase();
  if (isIP(name) !== 0 || !name.includes(".")) return name;
  const labels = name.split(".");
  const n = labels.length;
  const countryCode = n >= 3 && labels[n - 1].length === 2 && CC_SECOND_LEVEL.has(labels[n - 2]);
  return labels.slice(n - (countryCode ? 3 : 2)).join(".");
}

/** Whether two URLs or host names belong to the same registrable domain. */
export function sameSite(a: string, b: string): boolean {
  return registrableDomain(hostOf(a)) === registrableDomain(hostOf(b));
}

function hostOf(urlOrHost: string): string {
  try {
    return new URL(urlOrHost).hostname;
  } catch {
    return urlOrHost;
  }
}
