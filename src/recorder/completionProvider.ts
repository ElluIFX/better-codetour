// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vscode from "vscode";

const COMMANDS = [
  {
    label: vscode.l10n.t("Navigate to tour step"),
    detail: vscode.l10n.t("Navigate to the specified step in the current tour."),
    insertText: new vscode.SnippetString(
      "codetour.navigateToStep?"
    ).appendPlaceholder("stepNumber")
  },
  {
    label: vscode.l10n.t("Open URL"),
    detail: vscode.l10n.t("Open the specified URL in the default browser."),
    insertText: new vscode.SnippetString('vscode.open?["')
      .appendPlaceholder("url")
      .appendText('"]')
  },
  {
    label: vscode.l10n.t("Run build task"),
    detail: vscode.l10n.t("Run the build task configured by the current workspace."),
    insertText: new vscode.SnippetString("workbench.action.tasks.build")
  },
  {
    label: vscode.l10n.t("Run task"),
    detail: vscode.l10n.t("Run a task defined by the current workspace."),
    insertText: new vscode.SnippetString('workbench.action.tasks.runTask?["')
      .appendPlaceholder("taskName")
      .appendText('"]')
  },
  {
    label: vscode.l10n.t("Run test task"),
    detail: vscode.l10n.t("Run the test task configured by the current workspace."),
    insertText: new vscode.SnippetString("workbench.action.tasks.test")
  },
  {
    label: vscode.l10n.t("Run terminal command"),
    detail: vscode.l10n.t("Run a shell command in the integrated terminal."),
    insertText: new vscode.SnippetString('codetour.sendTextToTerminal?["')
      .appendPlaceholder("shellCommand")
      .appendText('"]')
  },
  {
    label: vscode.l10n.t("Start tour"),
    detail: vscode.l10n.t("Start another tour by title."),
    insertText: new vscode.SnippetString('codetour.startTourByTitle?["')
      .appendPlaceholder("tourTitle")
      .appendText('"]')
  }
];

class CodeTourCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
    const line = document.lineAt(position);
    if (line.text.includes("command:")) {
      return COMMANDS;
    }
  }
}

export function registerCompletionProvider() {
  vscode.languages.registerCompletionItemProvider(
    { scheme: "comment" },
    new CodeTourCompletionProvider(),
    ":"
  );
}
