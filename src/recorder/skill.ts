import * as vscode from "vscode";
import { EXTENSION_NAME } from "../constants";
import { ensureTourSchema } from "../store/persistence";

export const CODETOUR_AUTHORING_SKILL = `---
name: codetour-authoring
description: Create, review, or revise Better CodeTour .tour files for codebase walkthroughs, with resilient anchors and an appropriate balance between explanation depth and step count.
---

# CodeTour Authoring

Create a guided reading path through a codebase. Preserve the user's scope and source files unless code changes are explicitly requested.

## Ground the Tour

Before writing, inspect the relevant code, repository structure, and existing tours. Identify the audience, the question the tour should answer, and the smallest useful narrative arc. Read \`.tours/schema.json\` before choosing fields.

Build an outline around responsibilities and transitions rather than files alone. Start where execution, ownership, or data enters the relevant subsystem. End when the stated question has been answered; add an introduction or conclusion only when it supplies necessary orientation or synthesis.

## Balance Detail and Step Count

Treat one step as one cognitive unit: a responsibility, decision, state transition, invariant, or important handoff. Merge nearby observations when they explain the same idea in the same context. Split when the reader must change subsystem, abstraction level, lifecycle phase, or question.

Prefer a compact path through representative code over exhaustive coverage. Give enough context to explain why the selected code matters, then focus on the behavior that advances the tour. Remove repeated background, line-by-line paraphrases, incidental helpers, generated code, and details that the reader can infer directly.

There is no fixed ideal number of steps. Adjust the count using these signals:

- Merge steps whose descriptions would repeat the same purpose or setup.
- Split descriptions that contain multiple independent conclusions or unrelated code locations.
- Keep short call chains together when each transition needs little explanation.
- Give complex state changes, ownership boundaries, and failure handling their own steps.
- Re-read the full tour and remove any step that does not change the reader's understanding.

## Choose Resilient Anchors

Every file step uses \`file\` and exactly one \`anchor\`.

Prefer a symbol anchor for a named declaration reported by the language server. Store the complete symbol path from outermost to innermost declaration and use canonical English SymbolKind names such as \`Class\`, \`Method\`, \`Function\`, or \`Variable\`:

\`\`\`json
"anchor": {
  "type": "symbol",
  "path": [
    { "name": "TourProvider", "kind": "Class" },
    { "name": "refresh", "kind": "Method" }
  ]
}
\`\`\`

Use a content anchor for a stable, distinctive text block when no suitable symbol exists. Select the smallest exact block that remains unique and still communicates the intended location. Content matching resolves the first exact match, so avoid repeated fragments, volatile values, generated output, and unnecessarily broad selections.

Use a line anchor when symbol and content anchors are unsuitable or when the exact line is itself the subject. Line numbers are one-based:

\`\`\`json
"anchor": { "type": "line", "number": 42 }
\`\`\`

## Write Useful Steps

Lead each description with the role of the selected code in the tour. Explain the key behavior, constraint, or design decision, then connect it to the preceding or following step when that relationship is material.

Use concise Markdown. Add code blocks only when the excerpt itself is necessary to the explanation. Use command links and executable step commands only when the user requested them and their effects stay within the authorized scope. Keep titles short and specific.

Store tours as UTF-8 JSON under \`.tours\`, use a lowercase kebab-case filename, and set the header to:

\`\`\`json
"$schema": "./schema.json"
\`\`\`

Do not use legacy top-level \`line\` fields. Keep each step valid for exactly one supported step type.

## Validate

Before finishing:

1. Validate the JSON against \`.tours/schema.json\`.
2. Resolve every anchor and confirm that symbol and content steps display on the first matched line.
3. Play the tour in order and check that each transition advances the narrative.
4. Remove redundant steps and split overloaded descriptions.
5. Confirm that the tour remains useful without requiring unrequested source changes or external actions.
`;

interface WorkspaceItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
}

async function selectWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t("Open a workspace before creating a CodeTour skill.")
    );
    return;
  }

  if (folders.length === 1) {
    return folders[0].uri;
  }

  const selected = await vscode.window.showQuickPick<WorkspaceItem>(
    folders.map(folder => ({ label: folder.name, uri: folder.uri })),
    {
      placeHolder: vscode.l10n.t(
        "Select the workspace where the CodeTour skill will be created"
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
      `${EXTENSION_NAME}.createCodeTourSkill`,
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
          let exists = false;
          try {
            const stat = await vscode.workspace.fs.stat(skillUri);
            exists = stat.type === vscode.FileType.File;
          } catch {
            exists = false;
          }
          if (exists) {
            const openExisting = vscode.l10n.t("Open Existing");
            const overwrite = vscode.l10n.t("Overwrite");
            const response = await vscode.window.showWarningMessage(
              vscode.l10n.t(
                "A CodeTour authoring skill already exists in this workspace."
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
          }
          await ensureTourSchema(skillUri);
          await vscode.workspace.fs.writeFile(
            skillUri,
            new TextEncoder().encode(CODETOUR_AUTHORING_SKILL)
          );
          const document = await vscode.workspace.openTextDocument(skillUri);
          await vscode.window.showTextDocument(document, { preview: false });
          void vscode.window.showInformationMessage(
            vscode.l10n.t("Created the CodeTour authoring skill.")
          );
        } catch (error) {
          void vscode.window.showErrorMessage(
            vscode.l10n.t(
              "The CodeTour authoring skill could not be created: {0}",
              String(error)
            )
          );
        }
      }
    )
  );
}
