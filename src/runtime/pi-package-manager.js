import { DefaultPackageManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { arisaHomeDir } from "./paths.js";

function createPackageManager() {
  const settingsManager = SettingsManager.create(arisaHomeDir, arisaHomeDir);
  const packageManager = new DefaultPackageManager({
    cwd: arisaHomeDir,
    agentDir: arisaHomeDir,
    settingsManager
  });

  packageManager.setProgressCallback((event) => {
    if (event.type === "start") {
      process.stdout.write(`${event.message}\n`);
    }
  });

  return packageManager;
}

export async function installPiPackage(source) {
  const packageManager = createPackageManager();

  try {
    await packageManager.installAndPersist(source, { local: false });
    console.log(`Installed ${source}`);
    return { ok: true, code: 0 };
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return { ok: false, code: 1 };
  }
}

export async function removePiPackage(source) {
  const packageManager = createPackageManager();

  try {
    const removed = await packageManager.removeAndPersist(source, { local: false });
    if (!removed) {
      console.error(`No matching package found for ${source}`);
      return { ok: false, code: 1 };
    }
    console.log(`Removed ${source}`);
    return { ok: true, code: 0 };
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return { ok: false, code: 1 };
  }
}
