import assert from "node:assert/strict";
import test from "node:test";
import { campaignOperationArgs, executeDiscoveryOperations, prevalidateDiscoveryOperations } from "../discovery-operations.js";

test("prevalidates every discovery operation without letting one invalid item block valid work", async () => {
  const calls = [];
  const handlers = {
    "campaign-status": async (operation) => { calls.push(operation.id); return { contacts: 4 }; },
    "add-contact": async (operation) => { calls.push(operation.id); return { duplicate: false }; }
  };
  const result = await executeDiscoveryOperations([
    { id: "summary", action: "campaign-status" },
    { id: "bad", action: "add-contact", email: "a@example.com" },
    { id: "save", action: "add-contact", email: "b@example.com", name: "B", outlet: "Outlet" }
  ], handlers);

  assert.deepEqual(calls, ["summary", "save"]);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.results[1].validationErrors, ["name is required", "outlet is required"]);
  assert.equal(result.results[2].idempotent, true);
});

test("rejects duplicate ids and unsafe updateExisting while retaining individual results", () => {
  const validated = prevalidateDiscoveryOperations([
    { id: "same", action: "sources-check", urls: [] },
    { id: "same", action: "add-contact", email: "a@example.com", name: "A", outlet: "O", updateExisting: true }
  ]);

  assert.deepEqual(validated[0].errors, []);
  assert.match(validated[1].errors.join(" "), /id must be unique/);
  assert.match(validated[1].errors.join(" "), /does not allow updateExisting/);
});

test("strips only the operation correlation id before proxying campaign actions", () => {
  assert.deepEqual(campaignOperationArgs({ id: "save-1", action: "check-contact", email: "a@example.com" }), {
    action: "check-contact",
    email: "a@example.com"
  });
});
