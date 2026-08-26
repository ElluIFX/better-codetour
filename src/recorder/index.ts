import { registerRecorderCommands } from "./commands";
import { registerCompletionProvider } from "./completionProvider";
import * as vscode from "vscode";
import { registerCodeTourSkillCommand } from "./skill";

export function registerRecorderModule(context: vscode.ExtensionContext) {
  registerRecorderCommands(context);
  context.subscriptions.push(registerCompletionProvider());
  registerCodeTourSkillCommand(context);
}
