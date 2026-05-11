import { ExtensionContext } from "@foxglove/extension";

import { initSystemHealthPanel } from "./SystemHealthPanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "system-health", initPanel: initSystemHealthPanel });
}
