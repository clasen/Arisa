import assert from "node:assert/strict";
import test from "node:test";
import { runSequential } from "../index.js";

test("nested tool operations run one at a time", async () => {
  let active = 0;
  let peak = 0;
  const completed = [];
  const operation = (id, delay) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    completed.push(id);
    active -= 1;
    return id;
  };

  const results = await runSequential([
    operation("campaign", 15),
    operation("contacts", 5),
    operation("gmail", 1)
  ]);

  assert.equal(peak, 1);
  assert.deepEqual(completed, ["campaign", "contacts", "gmail"]);
  assert.deepEqual(results, completed);
});
