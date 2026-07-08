import { escapeHtml } from "./text-format.js";

const maxCopyTextLength = 256;
const maxButtonLabelLength = 64;

function truncateButtonLabel(text = "") {
  const source = String(text || "").trim();
  if (source.length <= maxButtonLabelLength) return source;
  return `${source.slice(0, maxButtonLabelLength - 1)}…`;
}

export function buildDeviceCodeTelegramMessage({ userCode, verificationUri, expiresInSeconds } = {}) {
  const code = String(userCode || "").trim();
  const uri = String(verificationUri || "").trim();
  const expiry = expiresInSeconds
    ? `\nExpires in ${Math.round(expiresInSeconds / 60)} minute(s).`
    : "";

  const lines = [
    "Open this URL:",
    uri ? `<a href="${escapeHtml(uri)}">${escapeHtml(uri)}</a>` : "",
    "Then enter code:",
    code ? `<code>${escapeHtml(code)}</code>` : "",
    escapeHtml(expiry.trim())
  ].filter(Boolean);

  const payload = {
    text: lines.join("\n"),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true }
  };

  const buttons = [];
  if (code && code.length <= maxCopyTextLength) {
    buttons.push({
      text: truncateButtonLabel(`Copy code: ${code}`),
      copy_text: { text: code }
    });
  }
  if (uri) {
    buttons.push({ text: "Open login page", url: uri });
  }
  if (buttons.length) {
    payload.reply_markup = { inline_keyboard: [buttons] };
  }

  return payload;
}
