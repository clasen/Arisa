import test from "node:test";
import assert from "node:assert/strict";
import { boundUtf8, normalizeMaxOutputBytes } from "../output-bounds.js";
import { isBlockedAddress, parsePublicHttpUrl, validatePublicUrl } from "../url-security.js";

test("rejects non-HTTP, credentialed, localhost, and private literal URLs", () => {
  for (const input of [
    "file:///etc/passwd",
    "https://user:pass@example.com/",
    "http://localhost/",
    "http://127.0.0.1/",
    "http://10.1.2.3/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/"
  ]) assert.throws(() => parsePublicHttpUrl(input));
});

test("accepts syntactically public HTTP(S) URLs", () => {
  assert.equal(parsePublicHttpUrl("https://example.com/path").hostname, "example.com");
  assert.equal(parsePublicHttpUrl("http://1.1.1.1/").hostname, "1.1.1.1");
});

test("blocks private DNS answers and accepts entirely public answers", async () => {
  await assert.rejects(
    validatePublicUrl("https://example.com", { lookup: async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }] }),
    /private or non-public/
  );
  const url = await validatePublicUrl("https://example.com", { lookup: async () => [{ address: "93.184.216.34" }] });
  assert.equal(url.href, "https://example.com/");
});

test("address policy catches representative private and special ranges", () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "172.16.0.1", "192.168.1.1", "224.0.0.1", "::", "::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test("bounds output by UTF-8 bytes without returning invalid text", () => {
  const source = "á".repeat(2000);
  const result = boundUtf8(source, 1024);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 1024);
  assert.match(result.text, /output truncated/);
  assert.equal(result.text.includes("�"), false);
  assert.equal(normalizeMaxOutputBytes(10), 1024);
  assert.equal(normalizeMaxOutputBytes(10_000_000), 1024 * 1024);
});
