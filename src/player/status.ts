// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { reaction } from "mobx";
import * as vscode from "vscode";
import { EXTENSION_NAME } from "../constants";
import { store } from "../store";
import { getTourTitle } from "../utils";

function createCurrentTourItem() {
  const currentTourItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left
  );

  currentTourItem.command = `${EXTENSION_NAME}.resumeTour`;
  currentTourItem.color = new vscode.ThemeColor(
    "statusBarItem.prominentForeground"
  );

  currentTourItem.show();
  return currentTourItem;
}

let currentTourItem: vscode.StatusBarItem | null = null;
export function registerStatusBar(context: vscode.ExtensionContext) {
  const disposeReaction = reaction(
    // @ts-ignore
    () => [
      store.activeTour
        ? [
            store.activeTour.step,
            store.activeTour.tour.title,
            store.activeTour.tour.steps.length
          ]
        : null,
      store.isRecording
    ],
    () => {
      if (store.activeTour) {
        if (!currentTourItem) {
          currentTourItem = createCurrentTourItem();
        }

        const tourTitle = getTourTitle(store.activeTour.tour);
        const progress = vscode.l10n.t(
          "CodeTour: #{0} of {1} ({2})",
          store.activeTour.step + 1,
          store.activeTour.tour.steps.length,
          tourTitle
        );
        currentTourItem.text = store.isRecording
          ? vscode.l10n.t("Recording {0}", progress)
          : progress;
      } else {
        if (currentTourItem) {
          currentTourItem.dispose();
          currentTourItem = null;
        }
      }
    }
  );
  context.subscriptions.push({ dispose: disposeReaction });
}
