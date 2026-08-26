// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { when } from "mobx";
import * as vscode from "vscode";
import { anchorResolver } from "../anchors";
import { EXTENSION_NAME } from "../constants";
import { focusPlayer } from "../player";
import { commitActiveTourEdit } from "../recorder/editSession";
import { saveTour } from "../store/persistence";
import { CodeTour, store } from "../store";
import {
  endCurrentCodeTour,
  exportTour,
  isTourEditable,
  moveCurrentCodeTourBackward,
  moveCurrentCodeTourForward,
  selectTour,
  startCodeTour
} from "../store/actions";
import { progress } from "../store/storage";
import { refreshTours } from "../store/provider";
import { parseCodeTour } from "../store/validation";
import { isWritableTourUri } from "../store/editability";
import {
  getStepFileUri,
  getWorkspaceUri,
  readUriContents
} from "../utils";
import { CodeTourNode } from "./tree/nodes";

let terminal: vscode.Terminal | null;

function getKnownTours() {
  const activeTours = store.activeTour
    ? [store.activeTour.tour, ...(store.activeTour.tours || [])]
    : [];
  return Array.from(
    new Map([...activeTours, ...store.tours].map(tour => [tour.id, tour])).values()
  );
}

function getTourContext(tour: CodeTour) {
  const activeTour = store.activeTour;
  const belongsToActiveGroup =
    !!activeTour &&
    (activeTour.tour.id === tour.id ||
      !!activeTour.tours?.some(candidate => candidate.id === tour.id));
  const isWorkspaceTour = store.tours.some(candidate => candidate.id === tour.id);
  return {
    workspaceRoot: belongsToActiveGroup
      ? activeTour!.workspaceRoot
      : vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(tour.id))?.uri ||
        getWorkspaceUri(tour),
    canEditTour:
      isWorkspaceTour
        ? isTourEditable(tour)
        : activeTour?.tour.id === tour.id
        ? activeTour.canEditTour !== false
        : belongsToActiveGroup
        ? false
        : isTourEditable(tour),
    tours: belongsToActiveGroup ? activeTour!.tours : undefined
  };
}

export function registerPlayerCommands(context: vscode.ExtensionContext) {
  const registerCommand = (
    command: string,
    callback: (...args: any[]) => any
  ) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  };

  registerCommand(
    `${EXTENSION_NAME}.openCodeTourPanel`,
    async () => {
      await vscode.commands.executeCommand("workbench.view.explorer");
      await vscode.commands.executeCommand(`${EXTENSION_NAME}.tours.focus`);
    }
  );

  registerCommand(`${EXTENSION_NAME}.refreshTours`, async () => {
    try {
      const count = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: vscode.l10n.t("Refreshing CodeTours...")
        },
        async () => {
          const refreshedCount = await refreshTours();
          await anchorResolver.resolveAll();
          return refreshedCount;
        }
      );
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Refreshed {0} CodeTours.", count)
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("CodeTour refresh failed: {0}", String(error))
      );
    }
  });

  // This is a "private" command that's used exclusively
  // by the hover description for tour markers.
  registerCommand(
    `${EXTENSION_NAME}._startTourById`,
    async (id: string, stepNumber: number) => {
      const tour = getKnownTours().find(tour => tour.id === id);
      if (tour && (await commitActiveTourEdit())) {
        const target = getTourContext(tour);
        startCodeTour(
          tour,
          stepNumber,
          target.workspaceRoot,
          false,
          target.canEditTour,
          target.tours
        );
      }
    }
  );

  // Purpose: Command link
  registerCommand(
    `${EXTENSION_NAME}.startTourByTitle`,
    async (title: string, stepNumber?: number) => {
      const tours = store.activeTour?.tours || store.tours;
      const tour = tours.find(tour => tour.title === title);
      if (tour && (await commitActiveTourEdit())) {
        const target = getTourContext(tour);
        startCodeTour(
          tour,
          stepNumber !== undefined ? stepNumber - 1 : undefined,
          target.workspaceRoot,
          false,
          target.canEditTour,
          target.tours
        );
      }
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.finishTour`,
    async (title?: string) => {
      await progress.update();

      if (title) {
        await vscode.commands.executeCommand(
          `${EXTENSION_NAME}.startTourByTitle`,
          title
        );
      } else {
        await vscode.commands.executeCommand(`${EXTENSION_NAME}.endTour`);
      }
    }
  );

  // Purpose: Command link
  registerCommand(
    `${EXTENSION_NAME}.navigateToStep`,
    async (stepNumber: number) => {
      if (!store.activeTour || !(await commitActiveTourEdit())) {
        return;
      }
      startCodeTour(
        store.activeTour.tour,
        stepNumber - 1,
        store.activeTour.workspaceRoot,
        false,
        store.activeTour.canEditTour !== false,
        store.activeTour.tours
      );
    }
  );

  // Purpose: Command link and the ">>" syntax
  registerCommand(
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

  registerCommand(
    `${EXTENSION_NAME}.insertCodeSnippet`,
    async (codeBlock: string) => {
      const codeSnippet = codeBlock;

      if (!store.activeTour) {
        return;
      }
      const step = store.activeTour.tour.steps[store.activeTour.step];
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

  registerCommand(
    `${EXTENSION_NAME}.startTour`,
    async (
      tour?: CodeTour | CodeTourNode,
      stepNumber?: number,
      workspaceRoot?: vscode.Uri,
      tours?: CodeTour[]
    ) => {
      if (tour) {
        const targetTour = tour instanceof CodeTourNode ? tour.tour : tour;
        const target = getTourContext(targetTour);
        if (
          store.activeTour?.tour.id !== targetTour.id
            ? !(await endCurrentCodeTour())
            : !(await commitActiveTourEdit())
        ) {
          return;
        }
        return startCodeTour(
          targetTour,
          stepNumber,
          workspaceRoot || target.workspaceRoot,
          false,
          target.canEditTour,
          tours || target.tours
        );
      }

      await selectTour(store.tours, workspaceRoot);
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.viewNotebook`,
    async (node: CodeTourNode) => {
      if (!(node instanceof CodeTourNode)) {
        return;
      }
      const tourUri = vscode.Uri.parse(node.tour.id);
      if (tourUri.scheme === "http" || tourUri.scheme === "https") {
        return vscode.window.showWarningMessage(
          vscode.l10n.t("Notebook view requires a file-backed CodeTour.")
        );
      }
      await vscode.commands.executeCommand(
        "vscode.openWith",
        tourUri,
        EXTENSION_NAME
      );
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.endTour`,
    endCurrentCodeTour
  );

  registerCommand(
    `${EXTENSION_NAME}.previousTourStep`,
    moveCurrentCodeTourBackward
  );

  registerCommand(
    `${EXTENSION_NAME}.nextTourStep`,
    moveCurrentCodeTourForward
  );

  registerCommand(`${EXTENSION_NAME}.resumeTour`, focusPlayer);

  registerCommand(
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

        const tour = parseCodeTour(contents, uri[0].toString());

        if (await commitActiveTourEdit()) {
          startCodeTour(
            tour,
            undefined,
            vscode.workspace.getWorkspaceFolder(uri[0])?.uri,
            false,
            isWritableTourUri(uri[0])
          );
        }
      } catch {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            "This file is not a valid tour. Inspect its contents and try again."
          )
        );
      }
    }
  );

  registerCommand(`${EXTENSION_NAME}.openTourUrl`, async () => {
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
      const tour = parseCodeTour(response.data, url);
      if (await commitActiveTourEdit()) {
        startCodeTour(tour, undefined, undefined, false, false);
      }
    } catch {
      vscode.window.showErrorMessage(
        vscode.l10n.t(
          "This file is not a valid tour. Inspect its contents and try again."
        )
      );
    }
  });

  registerCommand(
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

  registerCommand(
    `${EXTENSION_NAME}.hideMarkers`,
    () => void setShowMarkers(false)
  );

  registerCommand(
    `${EXTENSION_NAME}.showMarkers`,
    () => void setShowMarkers(true)
  );

  registerCommand(`${EXTENSION_NAME}.resetProgress`, () =>
    progress.reset()
  );
}
