export function createLogger({ verbose = false } = {}) {
  function stamp() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
  }

  function format(scope, message) {
    return `[${stamp()}]${scope ? ` [${scope}]` : ""} ${message}`;
  }

  return {
    verbose,
    log(scope, message) {
      if (!verbose) return;
      console.log(format(scope, message));
    },
    error(scope, message) {
      console.error(format(scope, message));
    }
  };
}
