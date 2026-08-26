import * as vscode from "vscode";
import { EXTENSION_NAME } from "../constants";
import { ensureTourSchema } from "../store/persistence";

const CODETOUR_AUTHORING_SKILL = `---
name: codetour-authoring
description: Create or revise Better CodeTour .tour files for focused, readable codebase walkthroughs using line, content, and symbol anchors.
---

# CodeTour Authoring

Create a guided reading path through the requested code. Preserve source files unless the user also requests code changes.

## Ground the Tour

Inspect the relevant code, repository structure, existing tours, and \`.tours/schema.json\`. Identify the intended reader and the question the tour should answer. Arrange steps by execution flow, ownership, state changes, or another coherent narrative rather than file order alone.

## Balance Information and Step Count

Use one step for one responsibility, decision, invariant, transition, or important handoff. Merge nearby code when it explains the same idea. Split when the reader changes subsystem, abstraction level, lifecycle phase, or question.

Prefer representative code over exhaustive coverage. Remove line-by-line paraphrases, repeated setup, incidental helpers, generated code, and steps that do not change the reader's understanding. There is no fixed step count: keep the smallest sequence that answers the tour's question without overloading individual descriptions.

## Choose Anchors

Every file step contains \`file\` and exactly one \`anchor\`.

Prefer a symbol anchor for a named declaration reported by the language server. Store the complete outer-to-inner path and canonical English SymbolKind names:

\`\`\`json
"anchor": {
  "type": "symbol",
  "path": [
    { "name": "TourProvider", "kind": "Class" },
    { "name": "refresh", "kind": "Method" }
  ]
}
\`\`\`

Use a content anchor for a stable, distinctive exact text block when no suitable symbol exists. Select the smallest useful block and remember that playback uses the first exact match.

Use a one-based line anchor when symbol and content anchors are unsuitable:

\`\`\`json
"anchor": { "type": "line", "number": 42 }
\`\`\`

Do not use legacy top-level line or multi-line fields.

## Write Steps

Lead with why the selected code matters, then explain its key behavior, constraint, or design decision. Connect adjacent steps when the transition is meaningful. Keep titles short and descriptions concise. Add code blocks only when the excerpt is necessary to the explanation.

Store UTF-8 JSON files under \`.tours\`, use a lowercase kebab-case filename, and set \`"$schema": "./schema.json"\`.

## Validate

Before finishing, validate the JSON against \`.tours/schema.json\`, resolve every anchor, play the steps in order, and remove redundant or overloaded steps.
`;

interface WorkspaceItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
}

async function selectWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Open a workspace before creating CodeTour authoring guidance."
      )
    );
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].uri;
  }

  const selected = await vscode.window.showQuickPick<WorkspaceItem>(
    folders.map(folder => ({ label: folder.name, uri: folder.uri })),
    {
      placeHolder: vscode.l10n.t(
        "Select the workspace where CodeTour authoring guidance will be created"
      )
    }
  );
  return selected?.uri;
}

export function registerCodeTourSkillCommand(
  context: vscode.ExtensionContext
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      `${EXTENSION_NAME}.createSkills`,
      async () => {
        const workspaceRoot = await selectWorkspaceRoot();
        if (!workspaceRoot) {
          return;
        }

        const skillUri = vscode.Uri.joinPath(
          workspaceRoot,
          ".tours",
          "SKILL.md"
        );
        try {
          try {
            await vscode.workspace.fs.stat(skillUri);
            const openExisting = vscode.l10n.t("Open Existing");
            const overwrite = vscode.l10n.t("Overwrite");
            const response = await vscode.window.showWarningMessage(
              vscode.l10n.t(
                "A CodeTour authoring SKILL.md already exists in this workspace."
              ),
              { modal: true },
              openExisting,
              overwrite
            );
            if (response === openExisting) {
              const document = await vscode.workspace.openTextDocument(skillUri);
              await vscode.window.showTextDocument(document, { preview: false });
              return;
            }
            if (response !== overwrite) {
              return;
            }
          } catch {
            // The file does not exist yet.
          }

          await ensureTourSchema(skillUri);
          await vscode.workspace.fs.writeFile(
            skillUri,
            new TextEncoder().encode(CODETOUR_AUTHORING_SKILL)
          );
          const document = await vscode.workspace.openTextDocument(skillUri);
          await vscode.window.showTextDocument(document, { preview: false });
          void vscode.window.showInformationMessage(
            vscode.l10n.t("Created .tours/SKILL.md.")
          );
        } catch (error) {
          void vscode.window.showErrorMessage(
            vscode.l10n.t(
              "Could not create .tours/SKILL.md: {0}",
              String(error)
            )
          );
        }
      }
    )
  );
}
