import { registerRecorderCommands } from "./commands";
import { registerCompletionProvider } from "./completionProvider";
import { registerCodeTourSkillCommand } from "./skill";
import * as vscode from "vscode";

export function registerRecorderModule(context: vscode.ExtensionContext) {
  registerRecorderCommands();
  registerCompletionProvider();
  registerCodeTourSkillCommand(context);
}
