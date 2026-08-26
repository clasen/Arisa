const FOCUSES = [
  {
    id: "reliability",
    label: "reliability and safety",
    questions: [
      "Which failures, retries, uncertain outcomes, duplicate risks, or safety stops repeated?",
      "Which safeguard worked, and which one needs clearer evidence or a tighter boundary?"
    ]
  },
  {
    id: "efficiency",
    label: "efficiency and repetition",
    questions: [
      "Which searches, tool calls, or manual corrections repeated without enough new information?",
      "What bounded change could reduce runtime, cost, or avoidable work without weakening verification?"
    ]
  },
  {
    id: "quality",
    label: "output quality and user corrections",
    questions: [
      "What did the user correct, rewrite, reject, or repeatedly clarify?",
      "Which language, personalization, evidence, or reporting rule should become more reliable?"
    ]
  },
  {
    id: "creative",
    label: "creative alternatives and assumptions",
    questions: [
      "Which assumption or habitual approach may be limiting results?",
      "What genuinely different method, source, tool combination, or experiment is worth proposing?"
    ]
  }
];

export function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function focusForPass(passNumber, passesPerFocus) {
  const pass = normalizePositiveInteger(passNumber, 1);
  const width = normalizePositiveInteger(passesPerFocus, 4);
  const index = Math.floor((pass - 1) / width) % FOCUSES.length;
  return FOCUSES[index];
}

export function buildReflectionPrompt({ passNumber, passesPerFocus, reviewWindowHours, maxProposals }) {
  const pass = normalizePositiveInteger(passNumber, 1);
  const focusWidth = normalizePositiveInteger(passesPerFocus, 4, { max: 20 });
  const focus = focusForPass(pass, focusWidth);
  const windowHours = normalizePositiveInteger(reviewWindowHours, 24, { max: 168 });
  const proposalLimit = normalizePositiveInteger(maxProposals, 3, { max: 5 });
  const cyclePass = ((pass - 1) % focusWidth) + 1;

  return `Periodic process retrospective, pass ${pass}. Primary lens: ${focus.label} (${cyclePass}/${focusWidth} before rotating focus). The primary lens guides attention but never limits the scope of the review.

Review the last ${windowHours} hours of relevant chat activity, scheduled-task outcomes, tool results, user corrections, and persisted operational state that is safe and necessary to inspect. Analyze the overall process at a general, reusable level rather than optimizing for one campaign, tool, or isolated task. Individual incidents are evidence, not the scope of the retrospective. Do not expose credentials or private payloads. Do not modify code, configuration, schedules, drafts, messages, or external systems during this turn.

Before drawing conclusions, reconstruct the whole review window rather than anchoring on the latest exchange. Build a private evidence inventory covering every explicit user correction, rejection, rewrite, or clarification; significant scheduled-task outcomes; meaningful tool successes or failures; repeated zero-result or no-change outcomes; and relevant state changes. Inspect activity from the beginning, middle, and end of the window when each exists. Do not show the inventory or private payloads to the user.

Query telemetry-ledger with action report using ${windowHours} hours for both the current and immediately preceding baseline window. Group by only relevant bounded dimensions. Treat insufficient-data as no conclusion, use regressions and improvements as evidence, and describe dimension breakdowns only as correlated hypotheses—not proven causes. If telemetry-ledger is unavailable or has no useful samples, continue with the other evidence and say nothing about missing telemetry.

Always evaluate all of these dimensions:
- reliability and safety: repeated failures, retries, uncertain outcomes, duplicate risks, and safeguards
- efficiency and repetition: repeated searches, calls, no-change cycles, cost, and avoidable work
- output quality and user corrections: rejected or clarified behavior, language, evidence, personalization, and reporting
- creative alternatives and assumptions: habitual approaches, limiting assumptions, and genuinely different experiments

Give extra attention to the current primary lens:
- ${focus.questions[0]}
- ${focus.questions[1]}

Use concrete evidence from distinct activities or time points when available. Separate temporary incidents from recurring process problems and distinguish technical success from useful outcomes. Check whether an earlier safeguard or proposal already addresses the issue. Abstract each proposal into a reusable process improvement. Do not propose change for its own sake.

If the process looks healthy and there is no useful evidence-backed improvement, remain silent. Otherwise send a concise retrospective with between 1 and ${proposalLimit} small, testable improvements, ordered by expected impact. Send the retrospective even when only one useful improvement is supported. Each improvement must include evidence, expected benefit, risk, and a way to measure the result. Ask before any implementation.`;
}

export function listFocuses() {
  return FOCUSES.map(({ id, label }) => ({ id, label }));
}
