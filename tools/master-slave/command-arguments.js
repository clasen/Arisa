const MAX_ARGV_ITEMS = 256;
const MAX_ARGUMENT_BYTES = 16_384;

function parseArgvJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("run_slave_command argvJson must be valid JSON");
  }
}

export function resolveCommandArgv({ argv, argvJson } = {}) {
  if (argv !== undefined && argvJson !== undefined) {
    throw new Error("run_slave_command accepts either argv or argvJson, not both");
  }
  const resolved = argvJson === undefined ? (argv ?? []) : parseArgvJson(argvJson);
  if (!Array.isArray(resolved)) throw new Error("run_slave_command arguments must be an array");
  if (resolved.length > MAX_ARGV_ITEMS) throw new Error(`run_slave_command accepts at most ${MAX_ARGV_ITEMS} arguments`);
  let bytes = 0;
  for (const argument of resolved) {
    if (typeof argument !== "string") throw new Error("run_slave_command arguments must contain only strings");
    if (argument.includes("\0")) throw new Error("run_slave_command arguments cannot contain NUL bytes");
    bytes += Buffer.byteLength(argument, "utf8");
  }
  if (bytes > MAX_ARGUMENT_BYTES) throw new Error(`run_slave_command arguments exceed ${MAX_ARGUMENT_BYTES} UTF-8 bytes`);
  return resolved;
}

export function resolveCommandTimeout(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const resolved = Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error("run_slave_command timeoutMs must be a positive integer");
  }
  return resolved;
}

export function normalizeRemoteCommandRequest(request) {
  if (request?.args?.action !== "run_slave_command") return request;
  const { argvJson, ...args } = request.args;
  return {
    ...request,
    args: {
      ...args,
      argv: resolveCommandArgv({ argv: args.argv, argvJson }),
      timeoutMs: resolveCommandTimeout(args.timeoutMs)
    }
  };
}
