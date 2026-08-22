import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MANAGERS = ["pnpm", "npm"];

async function exists(target) {
  return access(target).then(() => true, () => false);
}

function dependencyNames(packageJson, field) {
  const dependencies = packageJson?.[field];
  return dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)
    ? Object.keys(dependencies).sort()
    : [];
}

async function readPackage(stageDir) {
  const packageFile = path.join(stageDir, "package.json");
  if (!(await exists(packageFile))) return null;
  return JSON.parse(await readFile(packageFile, "utf8"));
}

function managerArguments(manager) {
  if (manager === "pnpm") return ["install", "--lockfile=false", "--ignore-workspace"];
  if (manager === "npm") return ["install", "--no-package-lock", "--workspaces=false"];
  throw new Error(`Unsupported package manager: ${manager}`);
}

async function missingRuntimeDependencies(stageDir, names) {
  const checks = await Promise.all(names.map(async (name) => ({
    name,
    present: await exists(path.join(stageDir, "node_modules", ...name.split("/"), "package.json"))
  })));
  return checks.filter((item) => !item.present).map((item) => item.name);
}

async function installWithManager({ stageDir, manager, runCommand, timeoutMs, runtimeDependencies }) {
  await rm(path.join(stageDir, "node_modules"), { recursive: true, force: true });
  await runCommand(manager, managerArguments(manager), { cwd: stageDir, timeoutMs });
  const missing = await missingRuntimeDependencies(stageDir, runtimeDependencies);
  if (missing.length) {
    throw new Error(`${manager} completed without staging runtime dependencies: ${missing.join(", ")}`);
  }
}

export async function installStagedDependencies(stageDir, {
  runCommand,
  timeoutMs = 180000,
  managers = DEFAULT_MANAGERS
} = {}) {
  if (typeof runCommand !== "function") throw new Error("installStagedDependencies requires runCommand");
  const packageJson = await readPackage(stageDir);
  if (!packageJson) return { installed: false };

  const runtimeDependencies = dependencyNames(packageJson, "dependencies");
  const optionalDependencies = dependencyNames(packageJson, "optionalDependencies");
  const developmentDependencies = dependencyNames(packageJson, "devDependencies");
  const dependencyCount = new Set([
    ...runtimeDependencies,
    ...optionalDependencies,
    ...developmentDependencies
  ]).size;
  if (!dependencyCount) return { installed: false };

  const failures = [];
  for (const manager of managers) {
    try {
      await installWithManager({ stageDir, manager, runCommand, timeoutMs, runtimeDependencies });
      return {
        installed: true,
        manager,
        dependencyCount,
        verifiedRuntimeDependencies: runtimeDependencies,
        ...(failures.length ? { fallbackFrom: failures.map((item) => item.message).join("\n") } : {})
      };
    } catch (error) {
      failures.push({ manager, message: error?.message || String(error) });
    }
  }

  const detail = failures.map((item) => `${item.manager}: ${item.message}`).join("\n");
  throw new Error(`Dependency staging failed with every package manager:\n${detail}`);
}
