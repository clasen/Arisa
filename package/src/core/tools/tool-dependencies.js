const TOOL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RANGE_PATTERN = /^(\^)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionParts(version) {
  const match = VERSION_PATTERN.exec(String(version || ""));
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function normalizeToolDependencies(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("toolDependencies must be an object");
  const normalized = {};
  for (const [name, range] of Object.entries(value)) {
    if (!TOOL_NAME_PATTERN.test(name)) throw new Error(`Invalid tool dependency name: ${name}`);
    if (!RANGE_PATTERN.test(String(range || ""))) throw new Error(`Unsupported tool dependency range for ${name}: ${range || "empty"}`);
    normalized[name] = String(range);
  }
  return normalized;
}

export function satisfiesToolVersion(version, range) {
  const actual = versionParts(version);
  const match = RANGE_PATTERN.exec(String(range || ""));
  if (!actual || !match) return false;
  const expected = match.slice(2).map(Number);
  if (!match[1]) return compareVersions(actual, expected) === 0;
  if (compareVersions(actual, expected) < 0) return false;
  if (expected[0] > 0) return actual[0] === expected[0];
  if (expected[1] > 0) return actual[0] === 0 && actual[1] === expected[1];
  return actual[0] === 0 && actual[1] === 0 && actual[2] === expected[2];
}

export function inspectToolDependencies(tools, rootName = null) {
  const issues = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (name, chain = []) => {
    if (visiting.has(name)) {
      issues.push({ tool: name, type: "cycle", dependency: name, chain: [...chain, name] });
      return;
    }
    if (visited.has(name)) return;
    const tool = tools.get(name);
    if (!tool) return;
    visiting.add(name);
    for (const [dependency, range] of Object.entries(normalizeToolDependencies(tool.toolDependencies))) {
      const installed = tools.get(dependency);
      if (!installed) {
        issues.push({ tool: name, type: "missing", dependency, range });
        continue;
      }
      if (!satisfiesToolVersion(installed.version, range)) {
        issues.push({ tool: name, type: "incompatible", dependency, range, installedVersion: installed.version || null });
        continue;
      }
      visit(dependency, [...chain, name]);
    }
    visiting.delete(name);
    visited.add(name);
  };
  if (rootName) visit(rootName);
  else for (const name of tools.keys()) visit(name);
  return issues;
}

export function resolveToolDependencyPlan(entries, rootName) {
  const tools = entries instanceof Map ? entries : new Map(Object.entries(entries || {}));
  const order = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (name, chain = []) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Official tool dependency is not locked: ${name}`);
    if (visiting.has(name)) throw new Error(`Circular official tool dependency: ${[...chain, name].join(" -> ")}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const [dependency, range] of Object.entries(normalizeToolDependencies(tool.toolDependencies))) {
      const lockedDependency = tools.get(dependency);
      if (!lockedDependency) throw new Error(`Official tool dependency is not locked: ${name} -> ${dependency}`);
      if (!satisfiesToolVersion(lockedDependency.version, range)) {
        throw new Error(`Locked tool dependency is incompatible: ${name} requires ${dependency}@${range}, lock has ${lockedDependency.version || "no version"}`);
      }
      visit(dependency, [...chain, name]);
    }
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  };
  visit(rootName);
  return order;
}
