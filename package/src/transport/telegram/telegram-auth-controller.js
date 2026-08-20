import {
  buildPiAuthRecoveryBlockedMessage,
  buildPiAuthTelegramMessage,
  getErrorMessage,
  getPiAuthIssue,
  getPiAuthStatus
} from "../../core/agent/auth-flow.js";
import { createPiOAuthLogin } from "../../core/agent/pi-auth-login.js";
import { buildDeviceCodeTelegramMessage } from "./device-code-message.js";
import { getIncomingMessageText } from "./prompt-builders.js";

function chatKey(chatId) {
  return String(chatId);
}

export function selectTelegramLoginOption(options = []) {
  return options.find((option) => /device/i.test(`${option.id} ${option.label}`))
    || options.find((option) => /browser|oauth|web/i.test(`${option.id} ${option.label}`))
    || options[0]
    || null;
}

export function createTelegramAuthController({
  config,
  api,
  agentManager,
  logger,
  markPromptErrorNotified = () => {}
}) {
  const renewals = new Map();
  let issue = null;

  function rememberIssue(error) {
    const detected = getPiAuthIssue(error);
    if (detected) issue = detected;
    return detected;
  }

  function rememberValidationFailure(error) {
    const detected = rememberIssue(error) || {
      kind: "validation-failed",
      message: getErrorMessage(error)
    };
    issue = detected;
    return detected;
  }

  async function notifyIssueIfNeeded(chatId, error) {
    const detected = rememberIssue(error);
    if (!detected) return false;

    try {
      await api.sendMessage(chatId, buildPiAuthTelegramMessage({ config, chatId, issue: detected }));
      markPromptErrorNotified(error);
      return true;
    } catch (notifyError) {
      logger?.error("telegram", `auth issue notice failed for chat ${chatId}: ${getErrorMessage(notifyError)}`);
      return false;
    }
  }

  async function finishRenewal(chatId, renewal) {
    try {
      await renewal.promise;
      await agentManager.validateAgent();
      agentManager.clearSessionCache(chatId);
      issue = null;
      logger?.log("telegram", `Pi auth renewal completed for chat ${chatId}`);
      await api.sendMessage(chatId, buildPiAuthTelegramMessage({ config, chatId, verified: true }));
    } catch (error) {
      const detected = rememberValidationFailure(error);
      logger?.error("telegram", `Pi auth renewal failed for chat ${chatId}: ${getErrorMessage(error)}`);
      await api.sendMessage(chatId, buildPiAuthTelegramMessage({ config, chatId, issue: detected })).catch((notifyError) => {
        logger?.error("telegram", `auth renewal failure notice failed for chat ${chatId}: ${getErrorMessage(notifyError)}`);
      });
    } finally {
      renewals.delete(chatKey(chatId));
    }
  }

  async function startRenewal(chatId) {
    const key = chatKey(chatId);
    const existing = renewals.get(key);
    if (existing) return { started: false, renewal: existing };

    const renewal = createPiOAuthLogin({
      provider: config.pi.provider,
      onSelect: async ({ message, options }) => {
        const selected = selectTelegramLoginOption(options);
        if (!selected) return undefined;
        logger?.log("telegram", `Pi auth option for chat ${chatId}: ${selected.id}`);
        await api.sendMessage(chatId, `${message}\nUsing: ${selected.label || selected.id}`);
        return selected.id;
      },
      onAuth: async ({ url, instructions }) => {
        await api.sendMessage(chatId, [
          instructions || "Open this URL to continue Pi authentication:",
          url,
          "After login, paste the full redirect URL back here."
        ].join("\n"));
      },
      onDeviceCode: async ({ userCode, verificationUri, expiresInSeconds }) => {
        const payload = buildDeviceCodeTelegramMessage({ userCode, verificationUri, expiresInSeconds });
        const { text, ...options } = payload;
        await api.sendMessage(chatId, text, options);
      },
      onPrompt: async ({ message, controller }) => {
        await api.sendMessage(chatId, `${message}\nReply here with the value.`);
        return controller.waitForManualCode();
      },
      onProgress: (message) => {
        if (message) logger?.log("telegram", `Pi auth progress for chat ${chatId}: ${message}`);
      }
    });

    renewals.set(key, renewal);
    finishRenewal(chatId, renewal);
    return { started: true, renewal };
  }

  async function submitRenewalInput(ctx) {
    const renewal = renewals.get(chatKey(ctx.chat.id));
    const text = getIncomingMessageText(ctx.message).trim();
    if (!renewal || !renewal.manualInputRequested || !text) return false;
    if (!renewal.submitManualCode(text)) return false;
    await ctx.reply("Got it. Finishing Pi login now...");
    return true;
  }

  function buildBlockedMessage(chatId) {
    return buildPiAuthRecoveryBlockedMessage({
      config,
      chatId,
      issue,
      renewalActive: renewals.has(chatKey(chatId))
    });
  }

  async function handleCommand(ctx, { authorize, withTyping }) {
    const authorization = await authorize(ctx);
    if (!authorization.ok) return;

    const status = getPiAuthStatus(config, ctx.chat.id);
    if (status.hasApiKey || !status.supportsOAuth) {
      await withTyping(ctx, async () => {
        try {
          await agentManager.validateAgent();
          agentManager.clearSessionCache(ctx.chat.id);
          issue = null;
          await ctx.reply(buildPiAuthTelegramMessage({ config, chatId: ctx.chat.id, verified: true }));
        } catch (error) {
          const detected = rememberValidationFailure(error);
          await ctx.reply(buildPiAuthTelegramMessage({ config, chatId: ctx.chat.id, issue: detected }));
        }
      });
      return;
    }

    try {
      const { started } = await startRenewal(ctx.chat.id);
      await ctx.reply(started
        ? "Starting Pi login from Telegram..."
        : "Pi login is already in progress. Paste the redirect URL or code here when you have it.");
    } catch (error) {
      const detected = rememberValidationFailure(error);
      await ctx.reply(buildPiAuthTelegramMessage({ config, chatId: ctx.chat.id, issue: detected }));
    }
  }

  return {
    buildBlockedMessage,
    getIssue: () => issue,
    handleCommand,
    hasActiveRenewal: (chatId) => renewals.has(chatKey(chatId)),
    notifyIssueIfNeeded,
    rememberIssue,
    startRenewal,
    submitRenewalInput
  };
}
