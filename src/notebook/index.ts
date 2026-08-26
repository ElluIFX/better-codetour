// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vscode from "vscode";
import { EXTENSION_NAME } from "../constants";
import { anchorResolver } from "../anchors";
import { store } from "../store";
import { parseCodeTour } from "../store/validation";
import { getStepFileUri, getWorkspaceUri } from "../utils";

class CodeTourNotebookProvider implements vscode.NotebookSerializer {
  async deserializeNotebook(
    content: Uint8Array,
    token: any
  ): Promise<vscode.NotebookData> {
    const contents = new TextDecoder().decode(content);

    const persistedTour = parseCodeTour(contents, "");
    const tour = { ...persistedTour };
    const knownTours = [
      ...(store.activeTour ? [store.activeTour.tour] : []),
      ...store.tours
    ];
    const knownTour = knownTours.find(
      candidate =>
        candidate.title === tour.title &&
        JSON.stringify(candidate.steps) === JSON.stringify(tour.steps)
    );
    tour.id = knownTour?.id || "";
    const workspaceRoot =
      knownTour && store.activeTour?.tour.id === knownTour.id
        ? store.activeTour.workspaceRoot
        : getWorkspaceUri(tour);
    tour.id ||= workspaceRoot?.toString() || "";
    const steps: any[] = [];

    for (const [stepNumber, item] of tour.steps.entries()) {
      const uri = await getStepFileUri(
        item,
        workspaceRoot,
        tour.ref,
        tour,
        stepNumber
      );
      const document = await vscode.workspace.openTextDocument(uri);
      const resolution = item.anchor
        ? await anchorResolver.resolveStep(tour, stepNumber)
        : undefined;
      const line = resolution?.range?.start.line || 0;

      const startLine = Math.max(line - 9, 0);
      const endLine = Math.min(line + 1, document.lineCount);
      const contents = document.getText(
        new vscode.Range(
          new vscode.Position(startLine, 0),
          new vscode.Position(endLine, 10000)
        )
      );
      steps.push({
        contents,
        language: document.languageId,
        description: item.description,
        uri
      });
    }

    const cells: vscode.NotebookCellData[] = [];

    // Title cell
    cells.push(
      new vscode.NotebookCellData(
        1,
        `## CodeTour (${tour.title}) - ${vscode.l10n.t(
          "{0} steps",
          steps.length
        )}\n\n${
          tour.description === undefined ? "" : tour.description
        }`,
        "markdown"
      )
    );

    steps.forEach((step, index) => {
      const cell = new vscode.NotebookCellData(2, step.contents, step.language);
      cell.outputs = [
        new vscode.NotebookCellOutput([
          new vscode.NotebookCellOutputItem(
            new TextEncoder().encode(
              `_${vscode.l10n.t(
                "Step #{0} of {1}",
                index + 1,
                steps.length
              )}:_ ${step.description} ([${vscode.l10n.t("View File")}](${
                step.uri
              }))`
            ),
            "text/markdown"
          )
        ])
      ];
      cells.push(cell);
    });

    const notebook = new vscode.NotebookData(cells);
    notebook.metadata = { codeTour: persistedTour };
    return notebook;
  }

  async serializeNotebook(
    data: vscode.NotebookData,
    token: any
  ): Promise<Uint8Array> {
    const tour = data.metadata?.codeTour;
    if (!tour) {
      throw new Error("The CodeTour notebook metadata is missing.");
    }
    return new TextEncoder().encode(JSON.stringify(tour, null, 2));
  }
}

export function registerNotebookProvider(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(
      EXTENSION_NAME,
      new CodeTourNotebookProvider()
    )
  );
}
