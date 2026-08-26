import { registerRecorderCommands } from "./commands";
import { registerCompletionProvider } from "./completionProvider";
import * as vscode from "vscode";

export function registerRecorderModule(context: vscode.ExtensionContext) {
  registerRecorderCommands();
  registerCompletionProvider();
}
