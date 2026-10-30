import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";

/** Resolves a host to every address it has (dns.lookup with all: true). */
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;
export const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true });

/** Blocked ranges, from the IANA special-purpose registries. Checked with net.BlockList, never with patterns. */
const BLOCKED = new BlockList();
const BLOCKED_IPV4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];
const BLOCKED_IPV6: [string, number][] = [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["2002::", 16],
];
for (const [net, prefix] of BLOCKED_IPV4) BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of BLOCKED_IPV6) BLOCKED.addSubnet(net, prefix, "ipv6");

/** An IPv6 address (any textual form, with an optional dotted tail and zone) as its 16 bytes; undefined if malformed. */
export function ipv6Bytes(text: string): Uint8Array | undefined {
  let s = text.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const parseGroups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!head || !tail) return undefined;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return undefined;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[2 * i] = g >> 8;
    bytes[2 * i + 1] = g & 0xff;
  });
  return bytes;
}

/**
 * Whether an address (IPv4 or IPv6 in any textual form) is one a scan must not reach. IPv4-mapped (::ffff:a.b.c.d) and
 * IPv4-compatible (::a.b.c.d) IPv6 addresses are unwrapped and their IPv4 part is checked too. Unparsable text is blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, "ipv4");
  if (family !== 6) return true;
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const zeroPrefix = bytes.subarray(0, 10).every((b) => b === 0);
  const mapped = bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = bytes[10] === 0 && bytes[11] === 0;
  // NAT64 well-known prefix 64:ff9b::/96: the IPv4 address is the last 32 bits.
  const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.subarray(4, 12).every((b) => b === 0);
  // ::ffff:0:0/96 (IPv4-mapped) is blocked as a whole. It is not a BlockList entry: an IPv6 subnet there also matches
  // plain IPv4 checks, which would block public IPv4 addresses.
  if (mapped && zeroPrefix) return true;
  if ((zeroPrefix && compatible) || nat64) {
    const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    if (BLOCKED.check(embedded, "ipv4")) return true;
  }
  return BLOCKED.check(address, "ipv6");
}

/**
 * A `lookup` for a socket that resolves the host with `resolver` and refuses the connection when any address is blocked.
 * The socket then connects to the address that was checked, so a DNS answer that changes later cannot redirect it.
 */
export function guardedLookup(resolver: Resolver): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
          callback(new Error(`refused: ${hostname} resolves to a blocked address`));
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      (err: unknown) => callback(err),
    );
  }) as unknown as LookupFunction;
}

