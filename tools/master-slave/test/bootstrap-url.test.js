import assert from "node:assert/strict";
import test from "node:test";
import { BOOTSTRAP_SECRET_PREFIX, createBootstrapSecret, parseBootstrapUrl } from "../lib/bootstrap-url.js";
import { addressesEqual, normalizeIpLiteral } from "../lib/ip-address.js";

const secret = createBootstrapSecret(() => Buffer.alloc(32, 0x5a));

test("parses exact IPv4 and bracketed IPv6 bootstrap URLs", () => {
  assert.deepEqual(parseBootstrapUrl(`tcp://198.51.100.12:4719/${secret}`), {
    endpoint: "tcp://198.51.100.12:4719",
    host: "198.51.100.12",
    port: 4719,
    secret,
    secretBytes: Buffer.alloc(32, 0x5a)
  });
  const ipv6 = parseBootstrapUrl(`tcp://[2001:0db8:0:0:0:0:0:1]:4719/${secret}`);
  assert.equal(ipv6.host, "2001:db8::1");
  assert.equal(ipv6.endpoint, "tcp://[2001:db8::1]:4719");
});

test("rejects non-literal hosts and every extra URL component", () => {
  for (const url of [
    `https://198.51.100.12:4719/${secret}`,
    `tcp://example.com:4719/${secret}`,
    `tcp://user@198.51.100.12:4719/${secret}`,
    `tcp://198.51.100.12/${secret}`,
    `tcp://198.51.100.12:4719/${secret}/extra`,
    `tcp://198.51.100.12:4719/${secret}?query=1`,
    `tcp://198.51.100.12:4719/${secret}#fragment`,
    `tcp://198.51.100.12:4719/`,
    `tcp://198.51.100.12:4719/${BOOTSTRAP_SECRET_PREFIX}short`,
    `tcp://198.51.100.12:4719/${secret}%2Fextra`
  ]) assert.throws(() => parseBootstrapUrl(url));
});

test("normalizes IPv4-mapped IPv6 without accepting partial matches", () => {
  assert.equal(normalizeIpLiteral("::ffff:192.0.2.128"), "192.0.2.128");
  assert.equal(addressesEqual("::ffff:192.0.2.128", "192.0.2.128"), true);
  assert.equal(addressesEqual("192.0.2.12", "192.0.2.128"), false);
  assert.equal(addressesEqual("not-an-address", "not-an-address"), false);
});
