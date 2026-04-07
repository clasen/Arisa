export function toolOk(output = {}, extra = {}) {
  return { ok: true, output, ...extra };
}

export function toolError(error, extra = {}) {
  return {
    ok: false,
    status: extra.status || "failed",
    error,
    ...extra
  };
}

export function toolNeedsConfig({ tool, missingConfig = [], configPath, message } = {}) {
  return {
    ok: false,
    status: "needs_config",
    error: message || `Missing tool configuration${tool ? ` for ${tool}` : ""}.`,
    missingConfig,
    configPath,
    resolution: {
      type: "user_config_required",
      tool,
      missingConfig,
      configPath
    }
  };
}

export function normalizeToolResult(name, result = {}) {
  if (!result || typeof result !== "object") {
    return toolError(`Invalid tool response for ${name}`);
  }

  if (result.ok === false && result.missingConfig?.length) {
    return {
      ...toolNeedsConfig({
        tool: name,
        missingConfig: result.missingConfig,
        configPath: result.configPath,
        message: result.error
      }),
      ...result,
      status: result.status || "needs_config",
      resolution: result.resolution || {
        type: "user_config_required",
        tool: name,
        missingConfig: result.missingConfig,
        configPath: result.configPath
      }
    };
  }

  if (result.ok === false) {
    return {
      ...toolError(result.error || `Tool failed: ${name}`),
      ...result,
      status: result.status || "failed"
    };
  }

  if (result.ok === true) {
    return {
      ...toolOk(result.output || {}),
      ...result,
      status: result.status || "ok"
    };
  }

  return toolError(`Invalid tool response for ${name}`, { rawResult: result });
}
