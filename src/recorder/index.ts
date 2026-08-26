import { registerRecorderCommands } from "./commands";
import { registerCompletionProvider } from "./completionProvider";
import { registerEditorWatcher } from "./watcher";
import * as vscode from "vscode";

export function registerRecorderModule(context: vscode.ExtensionContext) {
  registerRecorderCommands();
  registerCompletionProvider();
  registerEditorWatcher(context);
}
