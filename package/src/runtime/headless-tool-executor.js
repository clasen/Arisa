import { materializeToolOutput } from "../core/tools/tool-output-materializer.js";

export function createHeadlessToolExecutor({ artifactStore, taskStore, toolRegistry } = {}) {
  if (!artifactStore || !taskStore || !toolRegistry) {
    throw new Error("Headless tool executor requires artifact, task, and tool stores");
  }

  return {
    async runTool({ name, request, chatId }) {
      await toolRegistry.load();
      const result = await toolRegistry.run({ name, request, chatId });
      return materializeToolOutput({ result, name, chatId, artifactStore, taskStore });
    }
  };
}
