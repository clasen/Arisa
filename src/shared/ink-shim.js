// Shim for running CLI tools that use Ink without a TTY.
// Prevents "Raw mode is not supported" crash by providing a no-op setRawMode.
// Uses Object.defineProperty for robustness (Bun may make stdin props non-writable).
if (process.stdin) {
  if (!process.stdin.isTTY) {
    try { Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true, configurable: true }); }
    catch { process.stdin.isTTY = true; }
  }
  if (typeof process.stdin.setRawMode !== "function") {
    const noop = function () { return process.stdin; };
    try { Object.defineProperty(process.stdin, "setRawMode", { value: noop, writable: true, configurable: true }); }
    catch { process.stdin.setRawMode = noop; }
  }
}
