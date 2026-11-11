// © 2026 Yasuhiko Yokote

/**
 * Source IP address check.
 *
 * An HTTP API has no resource policy, so **this check is done by the server.**
 * The request cannot be blocked before it reaches the server, but it is rejected before token verification.
 *
 * Only IPv4 is handled, because the ranges published as Claude's source addresses
 * are given in IPv4. **A request arriving over IPv6 is not allowed.**
 */

export interface Cidr {
  /** Original notation. Used in logs and error reports. */
  text: string;
  base: number;
  mask: number;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Converts a dotted IPv4 address to a 32-bit number. `null` if invalid. */
export function parseIpv4(ip: string): number | null {
  const m = IPV4.exec(ip.trim());
  if (m === null) return null;
  let v = 0;
  for (let i = 1; i <= 4; i++) {
    const part = Number(m[i]);
    if (!Number.isInteger(part) || part < 0 || part > 255) return null;
    v = (v << 8) | part;
  }
  return v >>> 0;
}

/**
 * Parses `a.b.c.d/n`. An omitted `/n` is taken as `/32`.
 *
 * A notation that cannot be parsed **is not skipped silently: an exception is thrown.**
 * If a mistake in the setting showed up as "nobody is allowed", the cause would be hard to find.
 */
export function parseCidr(spec: string): Cidr {
  const text = spec.trim();
  const [addr, bitsText] = text.split("/");
  const base = parseIpv4(addr ?? "");
  if (base === null) {
    throw new Error(`Cannot be parsed as an IPv4 range: ${text}`);
  }
  const bits = bitsText === undefined ? 32 : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new Error(`Invalid prefix length: ${text}`);
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { text, base: (base & mask) >>> 0, mask };
}

/** Parses a comma-separated list. */
export function parseCidrs(spec: string): Cidr[] {
  const list = spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (list.length === 0) {
    throw new Error("The list of allowed source address ranges is empty");
  }
  return list.map(parseCidr);
}

/** Whether `ip` falls within any of the ranges. IPv6 and invalid notations are treated as not included. */
export function isAllowedIp(ip: string | undefined, cidrs: Cidr[]): boolean {
  if (ip === undefined) return false;
  const v = parseIpv4(ip);
  if (v === null) return false;
  return cidrs.some((c) => ((v & c.mask) >>> 0) === c.base);
}
