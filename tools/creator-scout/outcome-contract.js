export function authenticatedState(authenticated) {
  return {
    authorization: authenticated ? "authenticated" : "not_authenticated",
    target: "not_validated",
    purchase: "not_evaluated"
  };
}

export function preparedCheckoutState() {
  return {
    authorization: "authenticated",
    target: "checkout_terms_validated",
    purchase: "not_submitted"
  };
}

export function subscriptionState(subscriptionConfirmed) {
  return {
    authorization: "authenticated",
    target: "billing_status_validated",
    purchase: subscriptionConfirmed ? "subscription_confirmed" : "not_confirmed"
  };
}
