// © 2026 Yasuhiko Yokote

/**
 * Tests for the source IP address check.
 *
 * An HTTP API has no resource policy, so **this check is the only restriction on the source address.**
 * The main aim is that nothing that must be rejected is allowed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isAllowedIp, parseCidr, parseCidrs, parseIpv4 } from "../src/guard/ip.ts";

const CLAUDE = parseCidrs("160.79.104.0/21");

describe("parseIpv4", () => {
  test("valid notation", () => {
    assert.equal(parseIpv4("0.0.0.0"), 0);
    assert.equal(parseIpv4("255.255.255.255"), 4294967295);
    assert.equal(parseIpv4("160.79.104.0"), 0xa04f6800);
  });

  test("invalid notation returns null", () => {
    for (const s of ["", "1.2.3", "1.2.3.4.5", "256.0.0.1", "-1.0.0.0", "a.b.c.d", "1.2.3.04x", "::1"]) {
      assert.equal(parseIpv4(s), null, `must not be accepted: ${s}`);
    }
  });
});

describe("parseCidr", () => {
  test("parses the prefix length", () => {
    assert.equal(parseCidr("10.0.0.0/8").mask, 0xff000000);
    assert.equal(parseCidr("10.1.2.3/32").mask, 0xffffffff);
    assert.equal(parseCidr("0.0.0.0/0").mask, 0);
  });

  test("clears the bits outside the prefix", () => {
    // 160.79.104.0/21 and 160.79.111.255/21 denote the same range
    assert.equal(parseCidr("160.79.111.255/21").base, parseCidr("160.79.104.0/21").base);
  });

  test("omitting `/n` means /32", () => {
    assert.equal(parseCidr("1.2.3.4").mask, 0xffffffff);
  });

  test("notation that cannot be parsed throws", () => {
    for (const s of ["", "1.2.3.4/33", "1.2.3.4/-1", "1.2.3.4/abc", "not-an-ip", "2001:db8::/32"]) {
      assert.throws(() => parseCidr(s), `should throw: ${s}`);
    }
  });
});

describe("parseCidrs", () => {
  test("parses a comma-separated list", () => {
    const c = parseCidrs("160.79.104.0/21, 203.0.113.0/24");
    assert.equal(c.length, 2);
  });

  test("an empty list throws", () => {
    for (const s of ["", "  ", ",,"]) {
      assert.throws(() => parseCidrs(s));
    }
  });

  test("throws when even one entry is invalid", () => {
    // Skipping it silently would show up as "nobody is allowed", which is hard to diagnose
    assert.throws(() => parseCidrs("160.79.104.0/21,broken"));
  });
});

describe("isAllowedIp - the Claude range 160.79.104.0/21", () => {
  test("allows addresses inside the range", () => {
    for (const ip of ["160.79.104.0", "160.79.104.1", "160.79.107.255", "160.79.111.255"]) {
      assert.equal(isAllowedIp(ip, CLAUDE), true, `should be allowed: ${ip}`);
    }
  });

  test("rejects addresses just outside the boundary", () => {
    for (const ip of ["160.79.103.255", "160.79.112.0", "160.79.112.1"]) {
      assert.equal(isAllowedIp(ip, CLAUDE), false, `must not be allowed: ${ip}`);
    }
  });

  test("rejects unrelated addresses", () => {
    for (const ip of ["0.0.0.0", "127.0.0.1", "8.8.8.8", "255.255.255.255", "161.79.104.1"]) {
      assert.equal(isAllowedIp(ip, CLAUDE), false, `must not be allowed: ${ip}`);
    }
  });

  test("rejects IPv6, invalid notation and a missing address", () => {
    for (const ip of ["2001:db8::1", "::1", "160.79.104", "160.79.104.0/21", "", undefined]) {
      assert.equal(isAllowedIp(ip, CLAUDE), false, `must not be allowed: ${String(ip)}`);
    }
  });

  test("allows an address inside any one of several ranges", () => {
    const c = parseCidrs("160.79.104.0/21,203.0.113.0/24");
    assert.equal(isAllowedIp("203.0.113.10", c), true);
    assert.equal(isAllowedIp("160.79.105.1", c), true);
    assert.equal(isAllowedIp("198.51.100.1", c), false);
  });

  test("`0.0.0.0/0` allows every IPv4 address", () => {
    const all = parseCidrs("0.0.0.0/0");
    assert.equal(isAllowedIp("8.8.8.8", all), true);
    assert.equal(isAllowedIp("2001:db8::1", all), false, "IPv6 stays out of scope");
  });
});
