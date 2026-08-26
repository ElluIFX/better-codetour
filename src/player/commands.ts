// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { when } from "mobx";
import * as vscode from "vscode";
import { anchorResolver } from "../anchors";
import { EXTENSION_NAME } from "../constants";
import { focusPlayer } from "../player";
import { saveTour } from "../store/persistence";
import { CodeTour, store } from "../store";
import {
  endCurrentCodeTour,
  exportTour,
  moveCurrentCodeTourBackward,
  moveCurrentCodeTourForward,
  selectTour,
  startCodeTour
} from "../store/actions";
import { progress } from "../store/storage";
import { getStepFileUri, readUriContents } from "../utils";
import { CodeTourNode } from "./tree/nodes";

let terminal: vscode.Terminal | null;
export function registerPlayerCommands() {
  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.openCodeTourPanel`,
    async () => {
      await vscode.commands.executeCommand("workbench.view.explorer");
      await vscode.commands.executeCommand(`${EXTENSION_NAME}.tours.focus`);
    }
  );

  // This is a "private" command that's used exclusively
  // by the hover description for tour markers.
  vscode.commands.registerCommand(
    `${EXTENSION_NAME}._startTourById`,
    async (id: string, stepNumber: number) => {
      const tour = store.tours.find(tour => tour.id === id);
      if (tour) {
        startCodeTour(tour, stepNumber);
      }
    }
  );

  // Purpose: Command link
  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.startTourByTitle`,
    async (title: string, stepNumber?: number) => {
      const tours = store.activeTour?.tours || store.tours;
      const tour = tours.find(tour => tour.title === title);
      if (tour) {
        startCodeTour(
          tour,
          stepNumber && --stepNumber,
          store.activeTour?.workspaceRoot,
          undefined,
          undefined,
          store.activeTour?.tours
        );
      }
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.finishTour`,
    async (title?: string) => {
      await progress.update();

      if (title) {
        vscode.commands.executeCommand(
          `${EXTENSION_NAME}.startTourByTitle`,
          title
        );
      } else {
        vscode.commands.executeCommand(`${EXTENSION_NAME}.endTour`);
      }
    }
  );

  // Purpose: Command link
  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.navigateToStep`,
    async (stepNumber: number) => {
      startCodeTour(
        store.activeTour!.tour,
        --stepNumber,
        store.activeTour?.workspaceRoot,
        undefined,
        undefined,
        store.activeTour?.tours
      );
    }
  );

  // Purpose: Command link and the ">>" syntax
  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.sendTextToTerminal`,
    async (text: string) => {
      if (!terminal) {
        terminal = vscode.window.createTerminal("CodeTour");
        vscode.window.onDidCloseTerminal(term => {
          if (term.name === "CodeTour") {
            terminal = null;
          }
        });

        when(
          () => store.activeTour === null,
          () => terminal?.dispose()
        );
      }

      terminal.show();
      terminal.sendText(text, true);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.insertCodeSnippet`,
    async (codeBlock: string) => {
      const codeSnippet = decodeURIComponent(codeBlock);

      const step = store.activeTour!.tour.steps[store.activeTour!.step];
      const anchorResolution = step.anchor
        ? await anchorResolver.resolveStep(
            store.activeTour!.tour,
            store.activeTour!.step
          )
        : undefined;
      if (step.anchor && anchorResolution?.state !== "resolved") {
        return vscode.window.showWarningMessage(
          vscode.l10n.t(
            "Resolve or rebind this tour step before inserting code."
          )
        );
      }

      const activeTour = store.activeTour!;
      const targetUri =
        anchorResolution?.uri ||
        (step.file || step.uri || step.contents !== undefined
          ? await getStepFileUri(
              step,
              activeTour.workspaceRoot,
              activeTour.tour.ref,
              activeTour.tour,
              activeTour.step
            )
          : undefined);
      const editor = targetUri
        ? await vscode.window.showTextDocument(targetUri, { preview: false })
        : vscode.window.activeTextEditor;
      if (!editor) {
        return vscode.window.showWarningMessage(
          vscode.l10n.t("Open a text editor before inserting code.")
        );
      }

      let edited: boolean;
      if (step.anchor?.type !== "line" && anchorResolution?.selection) {
        edited = await editor.edit(e => {
          e.replace(anchorResolution.selection!, codeSnippet);
        });
      } else {
        const position =
          anchorResolution?.range?.start || new vscode.Position(0, 0);
        edited = await editor.edit(e => e.insert(position, codeSnippet));
      }

      if (!edited) {
        return vscode.window.showErrorMessage(
          vscode.l10n.t("The code snippet could not be inserted.")
        );
      }

      const lineAdjustment = codeSnippet.split("\n").length - 1;
      if (lineAdjustment > 0 && step.anchor?.type === "line") {
        step.anchor.number += lineAdjustment;
        await saveTour(store.activeTour!.tour);
      }

      await vscode.commands.executeCommand("editor.action.formatDocument");
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.startTour`,
    async (
      tour?: CodeTour | CodeTourNode,
      stepNumber?: number,
      workspaceRoot?: vscode.Uri,
      tours?: CodeTour[]
    ) => {
      if (tour) {
        const targetTour = tour instanceof CodeTourNode ? tour.tour : tour;
        return startCodeTour(
          targetTour,
          stepNumber,
          workspaceRoot,
          undefined,
          undefined,
          tours
        );
      }

      await selectTour(store.tours, workspaceRoot);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.viewNotebook`,
    async (node: CodeTourNode) => {
      const tourUri = vscode.Uri.parse(node.tour.id);
      await vscode.commands.executeCommand(
        "vscode.openWith",
        tourUri,
        EXTENSION_NAME
      );
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.endTour`,
    endCurrentCodeTour
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.previousTourStep`,
    moveCurrentCodeTourBackward
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.nextTourStep`,
    moveCurrentCodeTourForward
  );

  vscode.commands.registerCommand(`${EXTENSION_NAME}.resumeTour`, focusPlayer);

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.openTourFile`,
    async () => {
      const uri = await vscode.window.showOpenDialog({
        filters: {
          [vscode.l10n.t("Tours")]: ["tour"]
        },
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: vscode.l10n.t("Open Tour")
      });

      if (!uri) {
        return;
      }

      try {
        const contents = await readUriContents(uri[0]);

        const tour = JSON.parse(contents);
        tour.id = uri[0].toString();

        startCodeTour(tour);
      } catch {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            "This file is not a valid tour. Inspect its contents and try again."
          )
        );
      }
    }
  );

  vscode.commands.registerCommand(`${EXTENSION_NAME}.openTourUrl`, async () => {
    const url = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("Specify the URL of the tour file to open"),
      value: await vscode.env.clipboard.readText()
    });

    if (!url) {
      return;
    }

    try {
      const axios = await import("axios");
      const response = await axios.default.get<CodeTour>(url);
      const tour = response.data;
      tour.id = url;
      startCodeTour(tour);
    } catch {
      vscode.window.showErrorMessage(
        vscode.l10n.t(
          "This file is not a valid tour. Inspect its contents and try again."
        )
      );
    }
  });

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.exportTour`,
    async (node: CodeTourNode) => {
      const uri = await vscode.window.showSaveDialog({
        filters: {
          [vscode.l10n.t("Tours")]: ["tour"]
        },
        saveLabel: vscode.l10n.t("Export Tour")
      });

      if (!uri) {
        return;
      }

      const contents = await exportTour(node.tour, uri);
      const bytes = new TextEncoder().encode(contents);
      await vscode.workspace.fs.writeFile(uri, bytes);
    }
  );

  async function setShowMarkers(showMarkers: boolean) {
    store.showMarkers = showMarkers;

    await vscode.workspace
      .getConfiguration("codetour")
      .update("showMarkers", showMarkers, vscode.ConfigurationTarget.Global);

    await vscode.commands.executeCommand(
      "setContext",
      "codetour:showingMarkers",
      showMarkers
    );
  }

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.hideMarkers`,
    () => void setShowMarkers(false)
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.showMarkers`,
    () => void setShowMarkers(true)
  );

  vscode.commands.registerCommand(`${EXTENSION_NAME}.resetProgress`, () =>
    progress.reset()
  );
}
