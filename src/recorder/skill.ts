import * as vscode from "vscode";
import { EXTENSION_NAME } from "../constants";
import { ensureTourSchema } from "../store/persistence";

const CODETOUR_AUTHORING_SKILL = `---
name: codetour-authoring
description: Create, review, or revise Better CodeTour .tour files for focused codebase walkthroughs using valid line, content, and symbol anchors.
---

# CodeTour Authoring

Create a guided reading path that answers a specific question about a codebase. Preserve source files unless the user also requests code changes.

## Establish the Reading Path

Before writing:

1. Read \`.tours/schema.json\`, relevant source files, and existing tours.
2. Identify the intended reader, required prior knowledge, and the question the tour must answer.
3. Outline the smallest coherent path through entry points, important transitions, and the final outcome.
4. Choose the source location that best demonstrates each point.

Order steps by execution flow, data flow, lifecycle, ownership, or another explicit narrative. File order alone rarely forms a useful explanation.

## Balance Information and Step Count

Treat one step as one cognitive unit: a responsibility, decision, invariant, state transition, or important handoff.

- Merge nearby locations when they support the same conclusion and can share one concise explanation.
- Split a step when it changes subsystem, abstraction level, lifecycle phase, or the question being answered.
- Give complex ownership boundaries, state changes, and failure handling their own step when they are essential to the tour.
- Remove steps that only paraphrase code, repeat context, or name incidental helpers.
- Prefer representative code over exhaustive coverage.

There is no fixed ideal number of steps. Keep the smallest sequence that answers the stated question while allowing each description to remain focused.

## Create a Valid Tour File

Store UTF-8 JSON under \`.tours\`, use a lowercase kebab-case filename, and point to the colocated schema:

\`\`\`json
{
  "$schema": "./schema.json",
  "title": "How requests reach the worker",
  "description": "Follow one request from ingress to execution.",
  "steps": [
    {
      "file": "src/server.ts",
      "anchor": { "type": "line", "number": 42 },
      "description": "This handler validates the request before it enters the queue."
    }
  ]
}
\`\`\`

Every file step contains \`file\`, \`description\`, and exactly one \`anchor\`. Use workspace-relative paths with forward slashes. Follow \`.tours/schema.json\` for non-file step types and optional fields.

## Choose Anchors

Choose the most stable anchor that identifies the intended code. Prefer symbol, then content, then line when each option is suitable.

### Symbol Anchor

Use a symbol anchor for a named declaration returned by the active VS Code document symbol provider. Confirm that language support is enabled for the file. Store the complete outer-to-inner path and canonical English SymbolKind names such as \`Class\`, \`Method\`, \`Function\`, or \`Variable\`:

\`\`\`json
{
  "file": "src/tourProvider.ts",
  "anchor": {
    "type": "symbol",
    "path": [
      { "name": "TourProvider", "kind": "Class" },
      { "name": "refresh", "kind": "Method" }
    ]
  },
  "description": "Refresh rebuilds the panel model from the latest discovered tours."
}
\`\`\`

Use the innermost named symbol that owns the behavior being explained. Include parent symbols when needed to distinguish methods or members with the same name. Playback displays the message on the symbol's first line.

### Content Anchor

Use a content anchor when the relevant code has no suitable document symbol or when a precise statement or block is the subject of the explanation. The \`text\` value is a literal exact match after line endings are normalized. Whitespace, indentation, punctuation, and comments are part of the match. Playback uses the first occurrence in the file and displays the message on its first line.

Single-line example:

\`\`\`json
{
  "file": "src/store.ts",
  "anchor": {
    "type": "content",
    "text": "store.tours = discoveredTours;"
  },
  "description": "This assignment publishes the refreshed tour list to the observable store."
}
\`\`\`

Multi-line example; encode line breaks as \`\\n\` inside JSON strings:

\`\`\`json
{
  "file": "src/worker.ts",
  "anchor": {
    "type": "content",
    "text": "const task = queue.shift();\\nreturn task.execute();"
  },
  "description": "The worker removes one queued task and immediately transfers control to it."
}
\`\`\`

Select content deliberately:

- Copy the exact source text, preserving indentation and spacing.
- Include enough stable context to make the first occurrence the intended location.
- Keep the block as small as possible while retaining uniqueness and meaning.
- Avoid generated text, volatile literals, formatting-only lines, and broad blocks likely to change together.
- If the text occurs more than once, extend the selection with stable adjacent syntax or use a symbol anchor.
- Verify that an exact search finds the intended block first.

### Line Anchor

Use a one-based line anchor when symbol and content anchors are unsuitable or the exact line position is the subject:

\`\`\`json
{
  "file": "config/defaults.ts",
  "anchor": { "type": "line", "number": 42 },
  "description": "This default controls the initial worker concurrency."
}
\`\`\`

Use only \`anchor: { "type": "line", "number": ... }\`. Do not write legacy top-level line or multi-line fields.

## Write Explanations

Lead with the role of the selected code in the tour. Explain the key behavior, constraint, or design decision, then state the transition to the next step when it matters. Keep titles short and specific. Use concise Markdown and add code blocks only when the excerpt itself is necessary.

Descriptions should add information the reader cannot obtain by merely reading the selected lines. State concrete responsibilities, inputs, outputs, state changes, and ownership. Keep background near the first step that needs it.

## Validate

Before finishing:

1. Parse the file as JSON and validate it against \`.tours/schema.json\`.
2. Resolve every anchor; confirm content anchors select the intended first exact match and symbol anchors use the provider's actual path and kind.
3. Play the tour in order and verify that each step advances the narrative.
4. Merge repetitive steps, split overloaded steps, and remove explanations that only restate source text.
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
