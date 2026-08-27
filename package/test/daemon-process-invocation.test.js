import assert from "node:assert/strict";
import test from "node:test";
import { daemonProcessInvocation } from "../src/core/tools/daemon-processes.js";

test("gives Linux tool daemons a higher OOM kill priority than core", () => {
  assert.deepEqual(daemonProcessInvocation("/tool/index.js", {
    platform: "linux",
    nodePath: "/usr/bin/node",
    oomAdjustAvailable: true
  }), {
    command: "/usr/bin/choom",
    args: ["-n", "500", "--", "/usr/bin/node", "/tool/index.js", "daemon"],
    oomProtected: true
  });
});

test("starts tool daemons directly when OOM adjustment is unavailable", () => {
  assert.deepEqual(daemonProcessInvocation("/tool/index.js", {
    platform: "darwin",
    nodePath: "/usr/bin/node",
    oomAdjustAvailable: false
  }), {
    command: "/usr/bin/node",
    args: ["/tool/index.js", "daemon"],
    oomProtected: false
  });
});
