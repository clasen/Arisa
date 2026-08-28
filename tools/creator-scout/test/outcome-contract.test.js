import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticatedState,
  preparedCheckoutState,
  subscriptionState
} from "../outcome-contract.js";

test("authentication does not imply target or purchase validation", () => {
  assert.deepEqual(authenticatedState(true), {
    authorization: "authenticated",
    target: "not_validated",
    purchase: "not_evaluated"
  });
});

test("a prepared checkout explicitly remains unsubmitted", () => {
  assert.equal(preparedCheckoutState().target, "checkout_terms_validated");
  assert.equal(preparedCheckoutState().purchase, "not_submitted");
});

test("subscription confirmation requires billing evidence", () => {
  assert.equal(subscriptionState(false).purchase, "not_confirmed");
  assert.equal(subscriptionState(true).purchase, "subscription_confirmed");
});
