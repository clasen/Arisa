// Shim for running CLI tools that use Ink without a TTY.
// Prevents "Raw mode is not supported" crash by providing a no-op setRawMode.
// Must patch when isTTY is false — setRawMode may exist but throw at runtime.
if (process.stdin && !process.stdin.isTTY) {
  process.stdin.setRawMode = () => process.stdin;
  process.stdin.isTTY = true;
}
