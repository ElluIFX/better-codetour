// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vscode from "vscode";
import { CodeTour, store } from "../store";
import { saveTour } from "../store/persistence";

export function registerEditorWatcher(context: vscode.ExtensionContext) {
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleSave(tour: CodeTour) {
    const previous = saveTimers.get(tour.id);
    if (previous) {
      clearTimeout(previous);
    }
    saveTimers.set(
      tour.id,
      setTimeout(() => {
        saveTimers.delete(tour.id);
        void saveTour(tour);
      }, 500)
    );
  }

  const documentDisposable = vscode.workspace.onDidChangeTextDocument(event => {
    if (!store.activeEditorSteps || event.contentChanges.length === 0) {
      return;
    }

    const impactedSteps = store.activeEditorSteps.filter(
      ([, step, , line]) =>
        step.pattern &&
        line !== undefined &&
        event.contentChanges.some(change => change.range.start.line === line)
    );
    const changedTours = new Set<CodeTour>();
    impactedSteps.forEach(([tour, step, , line]) => {
      if (line === undefined || line >= event.document.lineCount) {
        return;
      }
      const changedText = event.document.lineAt(line).text.trim();
      if (!changedText) {
        return;
      }
      const newPattern =
        "^[^\\S\\n]*" +
        changedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = event.document.getText().match(new RegExp(newPattern, "gm"));
      if (matches?.length === 1 && newPattern !== step.pattern) {
        step.pattern = newPattern;
        changedTours.add(tour);
      }
    });
    changedTours.forEach(scheduleSave);
  });

  context.subscriptions.push(documentDisposable, {
    dispose() {
      saveTimers.forEach(timer => clearTimeout(timer));
    }
  });
}
