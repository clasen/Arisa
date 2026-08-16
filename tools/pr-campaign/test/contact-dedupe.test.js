import assert from "node:assert/strict";
import test from "node:test";
import { canonicalContactEmail, checkContactDuplicate } from "../contact-dedupe.js";

test("normalizes Gmail aliases without conflating unrelated domains", () => {
  assert.equal(canonicalContactEmail(" First.Last+press@GoogleMail.com "), "firstlast@gmail.com");
  assert.equal(canonicalContactEmail("first.last+press@example.com"), "first.last+press@example.com");
});

test("finds an existing contact and prior send without mutating state", () => {
  const state = {
    contacts: {
      "first.last@gmail.com": {
        email: "first.last@gmail.com",
        outlet: "Example",
        status: "contacted",
        drafts: [{ status: "sent" }]
      }
    },
    sends: [{ email: "firstlast+news@gmail.com", type: "first" }]
  };
  const before = structuredClone(state);
  const result = checkContactDuplicate(state, "First.Last+press@googlemail.com");
  assert.equal(result.duplicate, true);
  assert.equal(result.safeToAdd, false);
  assert.equal(result.exactContacts.length, 1);
  assert.equal(result.priorSendCount, 1);
  assert.deepEqual(state, before);
});

test("requires review before adding a new mailbox on an existing domain", () => {
  const state = {
    contacts: {
      "editor@example.com": { email: "editor@example.com", outlet: "Example", status: "contacted" }
    },
    sends: []
  };
  const result = checkContactDuplicate(state, "reviews@example.com");
  assert.equal(result.duplicate, false);
  assert.equal(result.safeToAdd, false);
  assert.equal(result.sameDomainReviewRequired, true);
  assert.equal(result.sameDomainContacts.length, 1);
});
