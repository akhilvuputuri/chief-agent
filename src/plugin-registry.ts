import { fileURLToPath } from "node:url";
import { PluginRegistry } from "./plugins.js";
export const plugins = new PluginRegistry(
  fileURLToPath(new URL("../plugins", import.meta.url)),
);
