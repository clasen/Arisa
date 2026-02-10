/**
 * @module core/format
 * @role Format responses for Telegram (HTML) and chunk long messages.
 * @responsibilities
 *   - Split text into chunks respecting Telegram's 4096 char limit
 *   - Safe HTML sending with plain-text fallback marker
 * @dependencies None
 * @effects None (pure functions)
 * @contract chunkMessage(text) => string[]
 */

const MAX_TELEGRAM_LENGTH = 4096;

export function chunkMessage(text: string): string[] {
  if (text.length <= MAX_TELEGRAM_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_TELEGRAM_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", MAX_TELEGRAM_LENGTH);
    if (splitAt === -1 || splitAt < MAX_TELEGRAM_LENGTH * 0.5) {
      splitAt = MAX_TELEGRAM_LENGTH;
    }

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  return chunks;
}
