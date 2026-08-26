// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { observable } from "mobx";
import { commands, ExtensionContext, Uri, workspace } from "vscode";
import { CodeTour, store } from ".";

const CODETOUR_PROGRESS_KEY = "codetour:progress";

export var progress: {
  update(): Promise<void>;
  isComplete(tour: CodeTour, stepNumber?: number): boolean;
  reset(tour?: CodeTour): Promise<void>;
};

function getProgress(tour: CodeTour) {
  const progress = store.progress.find(([id]) => tour.id === id);
  return progress?.[1] || observable([]);
}

export function initializeStorage(context: ExtensionContext) {
  store.progress = context.globalState.get(CODETOUR_PROGRESS_KEY) || [];

  progress = {
    async update() {
      const progress = store.progress.find(
        ([id]) => store.activeTour?.tour.id === id
      );

      if (progress) {
        if (!progress[1].includes(store.activeTour!.step)) {
          progress[1].push(store.activeTour!.step);
        }
      } else {
        store.progress.push([
          store.activeTour!.tour.id,
          [store.activeTour!.step]
        ]);
      }

      await commands.executeCommand(
        "setContext",
        "codetour:hasProgress",
        true
      );
      await context.globalState.update(CODETOUR_PROGRESS_KEY, store.progress);
    },
    isComplete(tour: CodeTour, stepNumber?: number): boolean {
      const tourProgress = getProgress(tour);
      if (stepNumber !== undefined) {
        return tourProgress.includes(stepNumber);
      } else {
        return tourProgress.length >= tour.steps.length;
      }
    },
    async reset(tour?: CodeTour) {
      store.progress = tour
        ? store.progress.filter(tourProgress => tourProgress[0] !== tour.id)
        : [];
      await commands.executeCommand(
        "setContext",
        "codetour:hasProgress",
        store.progress.length > 0
      );
      await context.globalState.update(CODETOUR_PROGRESS_KEY, store.progress);
    }
  };

  // @ts-ignore
  context.globalState.setKeysForSync([CODETOUR_PROGRESS_KEY]);

  const workspaceHasProgress = store.progress.some(([id]) =>
    workspace.getWorkspaceFolder(Uri.parse(id))
  );

  if (workspaceHasProgress) {
    commands.executeCommand("setContext", "codetour:hasProgress", true);
  }
}
