import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Bot } from "grammy";
import { prepareConfigForSave } from "../core/config/config-store.js";
import { configFile, ensureArisaHome } from "../platform/paths.js";
import { buildBootstrapConfig, parseYesNo } from "./bootstrap-config.js";
import { collectCliBootstrapChoices, openExternal } from "./bootstrap-cli.js";
import { runTelegramBootstrap } from "./bootstrap-telegram.js";

const ARISA_BANNER = [
  " █████╗ ██████╗ ██╗███████╗ █████╗ ",
  "██╔══██╗██╔══██╗██║██╔════╝██╔══██╗",
  "███████║██████╔╝██║███████╗███████║",
  "██╔══██║██╔══██╗██║╚════██║██╔══██║",
  "██║  ██║██║  ██║██║███████║██║  ██║",
  "╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚══════╝╚═╝  ╚═╝"
].join("\n");

async function exists(file) {
  try {
    await readFile(file, "utf8");
    return true;
  } catch {
    return false;
  }
}

function createSetupToken() {
  return crypto.randomBytes(18).toString("base64url");
}

export async function bootstrapIfNeeded({ force = false } = {}) {
  await ensureArisaHome();
  if (!force && await exists(configFile)) {
    return { configCreated: false, viaTelegram: false, startInBackground: false };
  }

  const rl = readline.createInterface({ input, output });
  const ask = async (label, fallback = "") => {
    const suffix = fallback ? ` (${fallback})` : "";
    const value = (await rl.question(`${label}${suffix}: `)).trim();
    return value || fallback;
  };

  console.log(`\n${ARISA_BANNER}`);
  console.log("-------- https://arisa.sh --------\n");
  console.log("Get Telegram bot token from https://t.me/BotFather");
  const telegramApiKey = await ask("Telegram bot token");

  try {
    const setupProbeBot = new Bot(telegramApiKey);
    const botInfo = await setupProbeBot.api.getMe();
    const answer = parseYesNo(await ask("Continue bootstrap from Telegram?", "Y"), true);
    const continueFromTelegram = answer === null ? true : answer;

    let result;
    if (continueFromTelegram) {
      const setupToken = createSetupToken();
      const setupLink = `https://t.me/${botInfo.username}?start=${setupToken}`;
      console.log(`\nOpen this link to continue setup in Telegram:\n${setupLink}\n`);
      await openExternal(setupLink);
      result = await runTelegramBootstrap({ telegramApiKey, setupToken, botInfo });
    } else {
      result = await collectCliBootstrapChoices({ telegramApiKey, rl, ask });
    }

    await writeFile(configFile, `${JSON.stringify(prepareConfigForSave(result.config), null, 2)}\n`, "utf8");
    console.log(`\nConfig saved to ${configFile}\n`);
    return {
      configCreated: true,
      viaTelegram: result.viaTelegram,
      startInBackground: result.startInBackground
    };
  } finally {
    rl.close();
  }
}

export { buildBootstrapConfig as buildConfig, configFile };
