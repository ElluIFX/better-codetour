// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { reaction } from "mobx";
import * as vscode from "vscode";
import { anchorResolver } from "../anchors";
import { FS_SCHEME_CONTENT } from "../constants";
import { CodeTourStepTuple, store } from "../store";
import { getStepFileUri, getWorkspaceUri } from "../utils";

const DISABLED_SCHEMES = [FS_SCHEME_CONTENT, "comment"];

let tourDecorator: vscode.TextEditorDecorationType | undefined;

export async function getTourSteps(
  editor: vscode.TextEditor
): Promise<CodeTourStepTuple[]> {
  const knownTours = [
    ...(store.activeTour ? [store.activeTour.tour] : []),
    ...(store.activeTour?.tours || []),
    ...store.tours
  ].filter(
    (tour, index, tours) =>
      tours.findIndex(candidate => candidate.id === tour.id) === index
  );
  const steps: CodeTourStepTuple[] = knownTours.flatMap(tour =>
    tour.steps.map(
      (step, stepNumber) => [tour, step, stepNumber] as CodeTourStepTuple
    )
  );

  const tourSteps = await Promise.all(
    steps.map(async ([tour, step, stepNumber]) => {
      const workspaceRoot =
        store.activeTour &&
        (store.activeTour.tour.id === tour.id ||
          store.activeTour.tours?.some(candidate => candidate.id === tour.id))
          ? store.activeTour.workspaceRoot || getWorkspaceUri(tour)
          : getWorkspaceUri(tour);
      const anchorResolution = step.anchor
        ? anchorResolver.get(tour, stepNumber) ||
          (await anchorResolver.resolveStep(tour, stepNumber))
        : undefined;
      const uri =
        anchorResolution?.uri ||
        (await getStepFileUri(step, workspaceRoot, tour.ref, tour, stepNumber));

      if (uri.toString().localeCompare(editor.document.uri.toString()) === 0) {
        const line = anchorResolution?.range?.start.line;
        if (step.anchor && anchorResolution?.state !== "resolved") {
          return;
        }

        if (line !== undefined) {
          return [tour, step, stepNumber, line];
        }
      }
    })
  );

  // @ts-ignore
  return tourSteps.filter(i => i);
}

let hoverProviderDisposable: vscode.Disposable | undefined;
function registerHoverProvider() {
  return vscode.languages.registerHoverProvider("*", {
    provideHover: async (
      document: vscode.TextDocument,
      position: vscode.Position
    ) => {
      if (!store.activeEditorSteps) {
        return;
      }

      const tourSteps = store.activeEditorSteps.filter(
        ([, , , line]) => line === position.line
      );
      const hovers = tourSteps.map(([tour, _, stepNumber]) => {
        const args = encodeURIComponent(JSON.stringify([tour.id, stepNumber]));
        const command = `command:codetour._startTourById?${args}`;
        const startTour = vscode.l10n.t("Start Tour");
        return `CodeTour: ${tour.title} (${vscode.l10n.t(
          "Step #{0}",
          stepNumber + 1
        )}) &nbsp;[${startTour}](${command} "${startTour}")\n`;
      });

      const content = new vscode.MarkdownString(hovers.join("\n"));
      content.isTrusted = true;
      return new vscode.Hover(content);
    }
  });
}

let decorationGeneration = 0;
export async function updateDecorations(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor
) {
  const generation = ++decorationGeneration;
  if (!tourDecorator) {
    return;
  }
  if (!editor || DISABLED_SCHEMES.includes(editor.document.uri.scheme)) {
    if (editor) {
      clearDecorations(editor);
    }
    return;
  }

  const steps = await getTourSteps(editor);
  if (
    generation !== decorationGeneration ||
    vscode.window.activeTextEditor?.document.uri.toString() !==
      editor.document.uri.toString()
  ) {
    return;
  }
  store.activeEditorSteps = steps;
  if (store.activeEditorSteps.length === 0) {
    return clearDecorations(editor);
  }

  const ranges = store.activeEditorSteps!.map(
    ([, , , line]) => new vscode.Range(line!, 0, line!, 1000)
  );
  editor.setDecorations(tourDecorator, ranges);
}

function clearDecorations(editor: vscode.TextEditor) {
  store.activeEditorSteps = undefined;
  if (tourDecorator) {
    editor.setDecorations(tourDecorator, []);
  }
}

export async function registerDecorators(context: vscode.ExtensionContext) {
  tourDecorator?.dispose();
  const decorator = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(
      context.extensionUri,
      "images",
      "icon.png"
    ),
    gutterIconSize: "contain",
    overviewRulerColor: "rgb(246,232,154)",
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  tourDecorator = decorator;
  const disposeReaction = reaction(
    () => [
      store.showMarkers,
      store.tours.map(tour => [
        tour.title,
        tour.steps.map(step => [step.file, step.anchor])
      ])
    ],
    () => {
      const activeEditor = vscode.window.activeTextEditor;

      if (store.showMarkers) {
        if (hoverProviderDisposable === undefined) {
          hoverProviderDisposable = registerHoverProvider();
        }

        if (activeEditor) {
          void updateDecorations(activeEditor);
        }
      } else {
        vscode.window.visibleTextEditors.forEach(clearDecorations);
        hoverProviderDisposable?.dispose();
        hoverProviderDisposable = undefined;
      }
    }
  );

  store.showMarkers = vscode.workspace
    .getConfiguration("codetour")
    .get("showMarkers", true);

  vscode.commands.executeCommand(
    "setContext",
    "codetour:showingMarkers",
    store.showMarkers
  );

  context.subscriptions.push(
    { dispose: disposeReaction },
    decorator,
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && store.showMarkers) {
        void updateDecorations(editor);
      }
    }),
    anchorResolver.onDidChange(() => {
      if (store.showMarkers && vscode.window.activeTextEditor) {
        void updateDecorations(vscode.window.activeTextEditor);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration("codetour.showMarkers")) {
        return;
      }
      store.showMarkers = vscode.workspace
        .getConfiguration("codetour")
        .get("showMarkers", true);
      void vscode.commands.executeCommand(
        "setContext",
        "codetour:showingMarkers",
        store.showMarkers
      );
    }),
    {
      dispose() {
        hoverProviderDisposable?.dispose();
        if (tourDecorator === decorator) {
          tourDecorator = undefined;
        }
      }
    }
  );
}
