import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import defaults from "./config.js";
import { buildReflectionPrompt, focusForPass, listFocuses, normalizePositiveInteger } from "./reflection-plan.js";
import { collectReviewSignals, evaluateReviewGate } from "./review-gate.js";
import { readState, writeState } from "./state-store.js";

const toolName = "process-retrospective";

function printHelp() {
  console.log(`process-retrospective

Usage:
  node index.js --help
  node index.js run --request-file <json>

Actions via args.action:
  start    Schedule a recurring retrospective poll. args: intervalSeconds?, initialDelaySeconds?, passesPerFocus?, reviewWindowHours?, maxProposals?, gateEnabled?, forceReviewSeconds?
  tick     Internal lightweight poll callback. It checks bounded correction/failure/regression signals before waking the agent.
  status   Show current pass count and focus.
  preview  Show the prompt for the next pass without changing state.
  disable  Stop future agent wake-ups from this run. Cancel the associated scheduled poll separately to remove it.

Defaults:
  - every 6 hours
  - review the latest 24 hours
  - rotate focus every 4 reasoned passes
  - skip unchanged polls and force one complete review every 24 hours
  - remain silent when no useful improvement is supported by evidence
  - never apply improvements automatically`);
}

function clean(value) {
  return String(value ?? "").trim();
}

function booleanValue(value) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "yes";
}

async function importCore(relativePath) {
  const packageDir = clean(process.env.ARISA_PACKAGE_DIR);
  if (!packageDir) throw new Error("ARISA_PACKAGE_DIR is required");
  return import(pathToFileURL(path.join(packageDir, "src", relativePath)).href);
}

function resolvedSettings(args, config) {
  return {
    intervalSeconds: normalizePositiveInteger(args.intervalSeconds, config.INTERVAL_SECONDS, { min: 3_600, max: 604_800 }),
    initialDelaySeconds: normalizePositiveInteger(args.initialDelaySeconds, config.INITIAL_DELAY_SECONDS, { min: 60, max: 604_800 }),
    passesPerFocus: normalizePositiveInteger(args.passesPerFocus, config.PASSES_PER_FOCUS, { min: 1, max: 20 }),
    reviewWindowHours: normalizePositiveInteger(args.reviewWindowHours, config.REVIEW_WINDOW_HOURS, { min: 1, max: 168 }),
    maxProposals: normalizePositiveInteger(args.maxProposals, config.MAX_PROPOSALS, { min: 1, max: 5 }),
    gateEnabled: args.gateEnabled === undefined ? booleanValue(config.GATE_ENABLED) : booleanValue(args.gateEnabled),
    forceReviewSeconds: normalizePositiveInteger(args.forceReviewSeconds, config.FORCE_REVIEW_SECONDS, { min: 3_600, max: 604_800 }),
    signalLookbackLimit: normalizePositiveInteger(args.signalLookbackLimit, config.SIGNAL_LOOKBACK_LIMIT, { min: 10, max: 100 })
  };
}

function nextPassDetails(state, settings) {
  const passNumber = Number(state.passCount || 0) + 1;
  const focus = focusForPass(passNumber, settings.passesPerFocus);
  const prompt = buildReflectionPrompt({ passNumber, ...settings });
  return { passNumber, focus, prompt };
}

async function start({ args, config, state, stateDir, toolOk }) {
  if (state.enabled && !booleanValue(args.restart)) {
    return toolOk({
      text: "Retrospective polling is already enabled.",
      enabled: true,
      passCount: state.passCount,
      runId: state.runId,
      intervalSeconds: state.intervalSeconds,
      nextFocus: focusForPass(Number(state.passCount || 0) + 1, state.passesPerFocus || config.PASSES_PER_FOCUS)
    });
  }

  const settings = resolvedSettings(args, config);
  const now = new Date();
  const runId = randomUUID();
  const nextState = {
    ...state,
    enabled: true,
    runId,
    passCount: booleanValue(args.reset) ? 0 : Number(state.passCount || 0),
    startedAt: now.toISOString(),
    lastRunAt: null,
    ...settings
  };
  await writeState(stateDir, nextState);

  const runAt = new Date(now.getTime() + (settings.initialDelaySeconds * 1000)).toISOString();
  return toolOk({
    text: `Retrospective polling enabled every ${settings.intervalSeconds} seconds; focus rotates every ${settings.passesPerFocus} passes.`,
    enabled: true,
    runId,
    runAt,
    ...settings,
    focuses: listFocuses()
  }, {
    status: "scheduled",
    asyncTask: {
      kind: "poll_tool",
      runAt,
      payload: { toolName, args: { action: "tick", runId } },
      recurrence: { type: "interval", everySeconds: settings.intervalSeconds }
    }
  });
}

async function tick({ args, config, state, stateDir, toolOk, arisa }) {
  if (!state.enabled) return toolOk({ text: "Retrospective wake-up skipped because this run is disabled.", skipped: "disabled" });
  if (clean(args.runId) && clean(args.runId) !== clean(state.runId)) {
    return toolOk({ text: "Retrospective wake-up skipped because this poll belongs to an older run.", skipped: "stale-run" });
  }

  const settings = resolvedSettings(state, config);
  let gate = null;
  if (settings.gateEnabled) {
    const signals = await collectReviewSignals(arisa, {
      reviewWindowHours: settings.reviewWindowHours,
      limit: settings.signalLookbackLimit
    });
    gate = evaluateReviewGate({
      state,
      signalIds: signals.signalIds,
      incomplete: signals.incomplete,
      forceReviewAfterMs: settings.forceReviewSeconds * 1000
    });
    if (!gate.shouldReview) {
      const nextState = {
        ...gate.nextState,
        lastRunAt: new Date().toISOString(),
        lastGateReason: gate.reason
      };
      await writeState(stateDir, nextState);
      return toolOk({
        text: "Retrospective reasoning skipped because no correction, failure, regression, or relevant state signal changed.",
        skipped: "unchanged-signals",
        gate: {
          reason: gate.reason,
          fingerprint: gate.fingerprint,
          nextForcedReviewAt: new Date(Date.parse(nextState.lastReasonedAt) + settings.forceReviewSeconds * 1000).toISOString(),
          gateChecks: nextState.gateChecks,
          gateSkips: nextState.gateSkips,
          reasonedTurns: nextState.reasonedTurns
        }
      });
    }
  }

  const details = nextPassDetails(state, settings);
  const nextState = {
    ...(gate?.nextState || state),
    passCount: details.passNumber,
    lastRunAt: new Date().toISOString(),
    lastFocus: details.focus.id,
    lastGateReason: gate?.reason || "disabled"
  };
  await writeState(stateDir, nextState);

  return toolOk({
    text: `Retrospective pass ${details.passNumber} queued with focus: ${details.focus.label}.`,
    passNumber: details.passNumber,
    focus: details.focus,
    gate: gate ? { reason: gate.reason, novelSignals: gate.novelSignals.length, fingerprint: gate.fingerprint } : { reason: "disabled" }
  }, {
    asyncTask: {
      kind: "agent_event",
      payload: { prompt: details.prompt }
    }
  });
}

async function run(requestFile) {
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  const args = request.args || {};
  const action = clean(args.action || "status").toLowerCase();
  const chatId = clean(request.chatId);
  if (!chatId) throw new Error("chatId is required");

  const [{ toolError, toolOk }, { loadToolConfig }, { getChatToolStateDir }, { createArisaClient }] = await Promise.all([
    importCore("core/tools/tool-result.js"),
    importCore("core/tools/tool-config.js"),
    importCore("runtime/paths.js"),
    importCore("core/tools/ipc-client.js")
  ]);
  const config = await loadToolConfig(toolName, defaults, chatId);
  const stateDir = getChatToolStateDir(chatId, toolName);
  const state = await readState(stateDir);

  if (action === "start") return console.log(JSON.stringify(await start({ args, config, state, stateDir, toolOk })));
  if (action === "tick") return console.log(JSON.stringify(await tick({
    args,
    config,
    state,
    stateDir,
    toolOk,
    arisa: createArisaClient({ toolName, chatId })
  })));
  if (action === "disable") {
    const nextState = await writeState(stateDir, { ...state, enabled: false, disabledAt: new Date().toISOString() });
    return console.log(JSON.stringify(toolOk({ text: "Retrospective agent wake-ups disabled. Cancel its scheduled poll to remove the recurring callback.", state: nextState })));
  }

  const settings = resolvedSettings(state, config);
  const details = nextPassDetails(state, settings);
  if (action === "preview") {
    return console.log(JSON.stringify(toolOk({ passNumber: details.passNumber, focus: details.focus, prompt: details.prompt })));
  }
  if (action === "status") {
    return console.log(JSON.stringify(toolOk({
      enabled: state.enabled,
      passCount: Number(state.passCount || 0),
      lastRunAt: state.lastRunAt,
      lastFocus: state.lastFocus || null,
      nextFocus: details.focus,
      gate: {
        lastReasonedAt: state.lastReasonedAt || null,
        lastGateAt: state.lastGateAt || null,
        lastGateReason: state.lastGateReason || null,
        gateChecks: Number(state.gateChecks || 0),
        gateSkips: Number(state.gateSkips || 0),
        reasonedTurns: Number(state.reasonedTurns || 0),
        forcedReviews: Number(state.forcedReviews || 0)
      },
      ...settings
    })));
  }

  console.log(JSON.stringify(toolError(`Unknown action: ${action}`)));
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help") || argv[0] === "help") {
  printHelp();
} else if (argv[0] === "run") {
  const fileIndex = argv.indexOf("--request-file");
  const requestFile = fileIndex >= 0 ? argv[fileIndex + 1] : "";
  if (!requestFile) {
    console.error("--request-file is required");
    process.exitCode = 1;
  } else {
    run(requestFile).catch((error) => {
      console.log(JSON.stringify({ ok: false, status: "failed", error: error?.message || String(error) }));
      process.exitCode = 1;
    });
  }
} else {
  printHelp();
}
