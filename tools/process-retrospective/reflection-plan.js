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

  return `Periodic process retrospective, pass ${pass}. Focus: ${focus.label} (${cyclePass}/${focusWidth} before rotating focus).

Review only the last ${windowHours} hours of relevant chat activity, scheduled-task outcomes, tool results, user corrections, and persisted operational state that is safe and necessary to inspect. Do not expose credentials or private payloads. Do not modify code, configuration, schedules, drafts, messages, or external systems during this turn.

Questions:
- ${focus.questions[0]}
- ${focus.questions[1]}

Use concrete evidence. Separate temporary incidents from recurring process problems. Check whether an earlier safeguard or proposal already addresses the issue. Propose at most ${proposalLimit} small, testable improvements, each with evidence, expected benefit, risk, and a way to measure the result. Do not propose change for its own sake.

If the process looks healthy or there is not enough evidence for a useful improvement, remain silent. Otherwise send the user a concise retrospective and ask before any implementation.`;
}

export function listFocuses() {
  return FOCUSES.map(({ id, label }) => ({ id, label }));
}
