const harnesses = [
  { runtime: "pi", label: "Pi Agent" },
  { runtime: "prime", label: "Prime Agent" }
];

export function harnessLabel(runtime) {
  return harnesses.find((item) => item.runtime === runtime)?.label || runtime;
}

export function buildHarnessPicker(activeRuntime) {
  return {
    text: `Current harness: ${harnessLabel(activeRuntime)}.`,
    replyMarkup: {
      inline_keyboard: harnesses.map(({ runtime, label }) => ([{
        text: `${runtime === activeRuntime ? "✓ " : ""}${label}`,
        callback_data: `harness:${runtime}`
      }]))
    }
  };
}

export function parseHarnessPickerAction(data) {
  const match = /^harness:(pi|prime)$/.exec(String(data || ""));
  return match ? { runtime: match[1] } : null;
}
