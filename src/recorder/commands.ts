// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { action, reaction, runInAction } from "mobx";
import * as path from "path";
import * as vscode from "vscode";
import { workspace } from "vscode";
import { anchorResolver } from "../anchors";
import { EXTENSION_NAME, FS_SCHEME_CONTENT } from "../constants";
import { api, RefType } from "../git";
import { CodeTourComment, getRecordingSelection } from "../player";
import { CodeTourNode, CodeTourStepNode } from "../player/tree/nodes";
import { CodeTour, CodeTourStep, store } from "../store";
import { saveTour } from "../store/persistence";
import {
  endCurrentCodeTour,
  exportTour,
  isTourEditable,
  onDidEndTour,
  startCodeTour
} from "../store/actions";
import { getActiveWorkspacePath, getRelativePath } from "../utils";
import {
  beginDraftStep,
  cancelActiveTourEdit,
  clearDraftStep,
  commitActiveTourEdit
} from "./editSession";

export { saveTour };

function normalizeSelectedText(text: string) {
  return text.replace(/\r\n/g, "\n");
}
function selectionContainsLine(selection: vscode.Selection, line: number) {
  const endLine =
    selection.end.character === 0 && selection.end.line > selection.start.line
      ? selection.end.line - 1
      : selection.end.line;
  return line >= selection.start.line && line <= endLine;
}

export function getGutterStepAnchor(
  document: vscode.TextDocument,
  selection: vscode.Selection | undefined,
  line: number
): NonNullable<CodeTourStep["anchor"]> {
  if (
    selection &&
    !selection.isEmpty &&
    selectionContainsLine(selection, line)
  ) {
    return {
      type: "content",
      text: normalizeSelectedText(document.getText(selection))
    };
  }
  return { type: "line", number: line + 1 };
}

export function registerRecorderCommands(context: vscode.ExtensionContext) {
  const registerCommand = (
    command: string,
    callback: (...args: any[]) => any
  ) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, callback)
    );
  };
  const registerTextEditorCommand = (
    command: string,
    callback: (
      textEditor: vscode.TextEditor,
      edit: vscode.TextEditorEdit,
      ...args: any[]
    ) => void
  ) => {
    context.subscriptions.push(
      vscode.commands.registerTextEditorCommand(command, callback)
    );
  };
  let pendingRebind:
    | {
        tourId: string;
        serializedStep: string;
        uri: vscode.Uri;
        confirmItem: vscode.StatusBarItem;
        cancelItem: vscode.StatusBarItem;
      }
    | undefined;

  function getNonEmptySelection(uri?: vscode.Uri) {
    const editor = vscode.window.visibleTextEditors.find(
      candidate => candidate.document.uri.toString() === uri?.toString()
    );
    return editor && !editor.selection.isEmpty
      ? { editor, selection: editor.selection }
      : undefined;
  }

  function getEditableActiveTour(expectedTourId?: string) {
    const activeTour = store.activeTour;
    if (
      !activeTour ||
      !store.isRecording ||
      activeTour.canEditTour === false ||
      (expectedTourId && activeTour.tour.id !== expectedTourId)
    ) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Start editing this CodeTour before modifying it.")
      );
      return;
    }
    return activeTour;
  }

  function ensureTourEditable(tour: CodeTour) {
    if (isTourEditable(tour)) {
      return true;
    }
    void vscode.window.showWarningMessage(
      vscode.l10n.t("This CodeTour source is read-only.")
    );
    return false;
  }

  function getCurrentTour(tourId: string, fallback?: CodeTour) {
    if (store.activeTour?.tour.id === tourId) {
      return store.activeTour.tour;
    }
    return store.tours.find(tour => tour.id === tourId) || fallback;
  }

  function findMatchingStep(
    tour: CodeTour,
    serializedStep: string,
    preferredIndex: number
  ) {
    if (
      tour.steps[preferredIndex] &&
      JSON.stringify(tour.steps[preferredIndex]) === serializedStep
    ) {
      return preferredIndex;
    }
    return tour.steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => JSON.stringify(step) === serializedStep)
      .sort(
        (left, right) =>
          Math.abs(left.index - preferredIndex) -
          Math.abs(right.index - preferredIndex)
      )[0]?.index;
  }

  function warnTourChanged() {
    void vscode.window.showWarningMessage(
      vscode.l10n.t("The CodeTour changed before the action completed. Try again.")
    );
  }

  async function insertAnchoredStep(
    editor: vscode.TextEditor,
    anchor: NonNullable<CodeTourStep["anchor"]>
  ) {
    if (!(await commitActiveTourEdit())) {
      return;
    }
    const activeTour = getEditableActiveTour();
    if (!activeTour) {
      return;
    }
    const previousStep = activeTour.step;
    const stepNumber = previousStep + 1;
    activeTour.step = stepNumber;
    const tour = activeTour.tour;
    const file = getRelativePath(
      getActiveWorkspacePath(),
      editor.document.uri.path
    );
    const step: CodeTourStep = {
      file,
      anchor,
      description: ""
    };
    tour.steps.splice(stepNumber, 0, step);
    await beginDraftStep(tour, step, previousStep);
    await anchorResolver.resolveStep(tour, stepNumber);
  }

  function clearPendingRebind() {
    pendingRebind?.confirmItem.dispose();
    pendingRebind?.cancelItem.dispose();
    pendingRebind = undefined;
  }

  context.subscriptions.push(
    onDidEndTour(() => {
      clearPendingRebind();
      clearDraftStep();
    }),
    {
      dispose: reaction(
        () => store.activeTour?.tour.id,
        activeTourId => {
          if (pendingRebind && pendingRebind.tourId !== activeTourId) {
            clearPendingRebind();
          }
        }
      )
    }
  );

  function getTourFileUri(workspaceRoot: vscode.Uri, title: string) {
    const normalizedTitle = title
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/\s+/gu, "-")
      .replace(/[^\p{L}\p{N}_-]+/gu, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const file =
      normalizedTitle ||
      `tour-${Array.from(title)
        .map(character => character.codePointAt(0)!.toString(16))
        .join("-")}`;

    const prefix = workspaceRoot.path.endsWith("/")
      ? workspaceRoot.path
      : `${workspaceRoot.path}/`;

    const customTourDirectory = vscode.workspace
      .getConfiguration(EXTENSION_NAME)
      .get("customTourDirectory", null);
    const normalizedTourDirectory = (customTourDirectory || ".tours")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/$/, "");
    const tourDirectory = normalizedTourDirectory || ".tours";

    return workspaceRoot.with({
      path: `${prefix}${tourDirectory}/${file}.tour`
    });
  }

  async function checkIfTourExists(workspaceRoot: vscode.Uri, title: string) {
    const uri = getTourFileUri(workspaceRoot, title);

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.type === vscode.FileType.File;
    } catch {
      return false;
    }
  }

  async function writeTourFile(
    workspaceRoot: vscode.Uri,
    title: string | vscode.Uri,
    ref?: string
  ): Promise<CodeTour> {
    const uri =
      typeof title === "string" ? getTourFileUri(workspaceRoot, title) : title;

    const tourTitle =
      typeof title === "string"
        ? title
        : path.basename(title.path).replace(".tour", "");

    const tour = {
      id: uri.toString(),
      title: tourTitle,
      steps: []
    } as CodeTour;

    if (ref && ref !== "HEAD") {
      tour.ref = ref;
    }

    await vscode.workspace.fs.createDirectory(
      uri.with({ path: path.posix.dirname(uri.path) })
    );
    await saveTour(tour);
    return tour;
  }

  interface WorkspaceQuickPickItem extends vscode.QuickPickItem {
    uri: vscode.Uri;
  }

  const REENTER_TITLE_RESPONSE = vscode.l10n.t("Re-enter title");
  async function recordTourInternal(
    tourTitle: string | vscode.Uri,
    workspaceRoot?: vscode.Uri
  ): Promise<CodeTour | undefined> {
    if (!workspaceRoot) {
      const workspaceFolders = workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        await vscode.window.showWarningMessage(
          vscode.l10n.t("Open a workspace folder before recording a CodeTour.")
        );
        return;
      }
      workspaceRoot = workspaceFolders[0].uri;

      if (workspaceFolders.length > 1) {
        const items: WorkspaceQuickPickItem[] = workspaceFolders.map(
          ({ name, uri }) => ({
            label: name,
            uri: uri
          })
        );

        const response = await vscode.window.showQuickPick(items, {
          placeHolder: vscode.l10n.t("Select the workspace to save the tour to")
        });

        if (!response) {
          return;
        }

        workspaceRoot = response.uri;
      }
    }

    if (typeof tourTitle === "string") {
      const tourExists = await checkIfTourExists(workspaceRoot, tourTitle);

      if (tourExists) {
        const response = await vscode.window.showErrorMessage(
          vscode.l10n.t(
            'This workspace already contains a tour titled "{0}".',
            tourTitle
          ),
          REENTER_TITLE_RESPONSE,
          vscode.l10n.t("Overwrite existing tour")
        );

        if (response === REENTER_TITLE_RESPONSE) {
          await vscode.commands.executeCommand(
            `${EXTENSION_NAME}.recordTour`,
            workspaceRoot,
            tourTitle
          );
          return;
        } else if (!response) {
          // If the end-user closes the error
          // dialog, then cancel the recording.
          return;
        }
      }
    }

    const ref = await promptForTourRef(workspaceRoot);
    if (ref === CANCELLED_GIT_REF) {
      return;
    }

    if (store.activeTour) {
      if (!(await endCurrentCodeTour(false))) {
        return;
      }
    }

    const tour = await writeTourFile(workspaceRoot, tourTitle, ref);

    startCodeTour(tour, undefined, workspaceRoot, true);

    vscode.window.showInformationMessage(
      vscode.l10n.t(
        "CodeTour recording started. Open a file and use its gutter plus button or editor context menu to add steps."
      )
    );
    return tour;
  }

  registerCommand(
    `${EXTENSION_NAME}.recordTour`,
    async (workspaceRoot?: vscode.Uri, placeHolderTitle?: string) => {
      const inputBox = vscode.window.createInputBox();
      inputBox.title = vscode.l10n.t(
        "Specify the tour title or save it to a specific location"
      );
      inputBox.value = placeHolderTitle || "";
      inputBox.buttons = [
        {
          iconPath: new vscode.ThemeIcon("save-as"),
          tooltip: vscode.l10n.t("Save tour as...")
        }
      ];

      inputBox.onDidAccept(async () => {
        const title = inputBox.value.trim();
        inputBox.hide();

        if (!title) {
          return;
        }

        await recordTourInternal(title, workspaceRoot);
      });

      inputBox.onDidTriggerButton(async button => {
        inputBox.hide();

        const uri = await vscode.window.showSaveDialog({
          filters: {
            [vscode.l10n.t("Tours")]: ["tour"]
          },
          saveLabel: vscode.l10n.t("Save Tour")
        });

        if (!uri) {
          return;
        }

        const recordedTour = await recordTourInternal(uri, workspaceRoot);
        if (!recordedTour) {
          return;
        }

        const disposeEndTourHandler = onDidEndTour(async tour => {
          if (tour.id === uri.toString()) {
            disposeEndTourHandler.dispose();

            if (
              await vscode.window.showInformationMessage(
                vscode.l10n.t("Would you like to export this tour?"),
                vscode.l10n.t("Export Tour")
              )
            ) {
              const content = await exportTour(tour, uri);
              await vscode.workspace.fs.writeFile(
                uri,
                new TextEncoder().encode(content)
              );
            }
          }
        });

      });

      inputBox.onDidHide(() => inputBox.dispose());

      inputBox.show();
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.addContentStep`,
    action(async (node?: CodeTourStepNode | CodeTourNode) => {
      if (!(await commitActiveTourEdit())) {
        return;
      }
      const activeTour = getEditableActiveTour(node?.tour.id);
      if (!activeTour) {
        return;
      }
      const activeTourId = activeTour.tour.id;
      const previousStep = activeTour.step;
      const value = previousStep === -1 ? vscode.l10n.t("Introduction") : "";
      const title = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Specify the title of the step"),
        value
      });

      if (!title) {
        return;
      }

      if (getEditableActiveTour(activeTourId) !== activeTour) {
        return;
      }

      let stepNumber;
      if (node instanceof CodeTourStepNode) {
        stepNumber = node.stepNumber + 1;
      } else {
        stepNumber = previousStep + 1;
      }
      activeTour.step = stepNumber;

      const tour = activeTour.tour;

      const step: CodeTourStep = {
        title,
        description: ""
      };
      tour.steps.splice(stepNumber, 0, step);
      await beginDraftStep(tour, step, previousStep);
    })
  );

  registerCommand(
    `${EXTENSION_NAME}.addDirectoryStep`,
    action(async (uri: vscode.Uri) => {
      if (!(uri instanceof vscode.Uri) || !(await commitActiveTourEdit())) {
        return;
      }
      const activeTour = getEditableActiveTour();
      if (!activeTour) {
        return;
      }
      const previousStep = activeTour.step;
      const stepNumber = previousStep + 1;
      activeTour.step = stepNumber;
      const tour = activeTour.tour;

      const workspaceRoot = getActiveWorkspacePath();
      const directory = getRelativePath(workspaceRoot, uri.path);

      const step: CodeTourStep = {
        directory,
        description: ""
      };
      tour.steps.splice(stepNumber, 0, step);
      await beginDraftStep(tour, step, previousStep);
    })
  );

  registerTextEditorCommand(
    `${EXTENSION_NAME}.addSelectionStep`,
    action(async (editor: vscode.TextEditor) => {
      if (editor.selection.isEmpty) {
        return vscode.window.showWarningMessage(
          vscode.l10n.t(
            "Select source text before adding a content-matched tour step."
          )
        );
      }
      await insertAnchoredStep(editor, {
        type: "content",
        text: normalizeSelectedText(editor.document.getText(editor.selection))
      });
    })
  );

  registerTextEditorCommand(
    `${EXTENSION_NAME}.addSymbolStep`,
    action(async (editor: vscode.TextEditor) => {
      const symbol = await anchorResolver.findSymbolAt(
        editor.document.uri,
        editor.selection.active
      );
      if (!symbol) {
        return vscode.window.showWarningMessage(
          vscode.l10n.t(
            "No document symbol is available at the current cursor position."
          )
        );
      }
      await insertAnchoredStep(editor, {
        type: "symbol",
        path: symbol.path
      });
    })
  );

  registerCommand(
    `${EXTENSION_NAME}.addTourStep`,
    action(async (reply: vscode.CommentReply) => {
      const activeTour = getEditableActiveTour();
      if (!activeTour || !reply?.thread || !reply.text.trim()) {
        return;
      }
      if (activeTour.thread) {
        activeTour.thread.dispose();
      }

      activeTour.thread = reply.thread;

      const tour = activeTour.tour;
      const thread = activeTour.thread;

      const workspaceRoot = getActiveWorkspacePath();
      const file = getRelativePath(workspaceRoot, thread!.uri.path);

      const step: CodeTourStep = {
        file,
        description: reply.text
      };

      const selected = getNonEmptySelection(thread!.uri);
      const cachedSelection = getRecordingSelection(
        thread!.uri,
        thread!.range.start.line
      );
      const selection =
        selected?.selection || cachedSelection;
      const document =
        selected?.editor.document ||
        (await workspace.openTextDocument(thread!.uri));
      const currentActiveTour = getEditableActiveTour(tour.id);
      if (!currentActiveTour || currentActiveTour.thread !== thread) {
        thread!.dispose();
        return;
      }
      step.anchor = getGutterStepAnchor(
        document,
        selection,
        thread!.range.start.line
      );

      currentActiveTour.step++;

      const stepNumber = currentActiveTour.step;

      thread!.dispose();
      currentActiveTour.thread = null;
      currentActiveTour.tour.steps.splice(stepNumber, 0, step);

      store.isEditing = false;
      await vscode.commands.executeCommand(
        "setContext",
        `${EXTENSION_NAME}:isEditing`,
        false
      );

      await saveTour(currentActiveTour.tour);
      await anchorResolver.resolveStep(currentActiveTour.tour, stepNumber);
    })
  );

  registerCommand(
    `${EXTENSION_NAME}.editTour`,
    async (node: CodeTourNode | vscode.CommentThread) => {
      if (node instanceof CodeTourNode) {
        if (!ensureTourEditable(node.tour)) {
          return;
        }
        if (!(await commitActiveTourEdit())) {
          return;
        }
        const activeTour =
          store.activeTour?.tour.id === node.tour.id
            ? store.activeTour
            : undefined;
        startCodeTour(
          node.tour,
          activeTour?.step,
          activeTour?.workspaceRoot,
          true,
          true,
          activeTour?.tours
        );
      } else if (store.activeTour) {
        if (store.activeTour.canEditTour === false) {
          return;
        }
        if (!(await commitActiveTourEdit())) {
          return;
        }
        startCodeTour(
          store.activeTour.tour,
          store.activeTour.step,
          store.activeTour.workspaceRoot,
          true,
          true,
          store.activeTour.tours
        );
      }
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.editTourAtStep`,
    async (node: CodeTourStepNode) => {
      if (
        !(node instanceof CodeTourStepNode) ||
        !ensureTourEditable(node.tour)
      ) {
        return;
      }
      const requestedStep = node.tour.steps[node.stepNumber];
      if (!requestedStep || !(await commitActiveTourEdit())) {
        return;
      }
      const tour =
        store.activeTour?.tour.id === node.tour.id
          ? store.activeTour.tour
          : store.tours.find(candidate => candidate.id === node.tour.id);
      const stepNumber = tour?.steps.indexOf(requestedStep) ?? -1;
      if (!tour || stepNumber < 0) {
        return;
      }
      startCodeTour(tour, stepNumber, undefined, true, true);
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.rebindTourStepAnchor`,
    async (node?: CodeTourStepNode) => {
      const tour = node?.tour || store.activeTour?.tour;
      const stepNumber = node?.stepNumber ?? store.activeTour?.step;
      if (!tour || stepNumber === undefined || stepNumber < 0) {
        return;
      }
      if (!ensureTourEditable(tour) || !(await commitActiveTourEdit())) {
        return;
      }
      const step = tour.steps[stepNumber];
      if (!step.anchor || !step.file) {
        return;
      }

      clearPendingRebind();
      const workspaceRoot =
        vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(tour.id))?.uri ||
        store.activeTour?.workspaceRoot;
      if (!workspaceRoot) {
        return vscode.window.showErrorMessage(
          vscode.l10n.t(
            "The source workspace for this tour step is unavailable."
          )
        );
      }

      const uri = vscode.Uri.joinPath(workspaceRoot, step.file);
      const editor = await vscode.window.showTextDocument(uri);
      const resolution = await anchorResolver.resolveStep(tour, stepNumber);
      if (resolution?.selection) {
        editor.selection = resolution.selection;
        editor.revealRange(resolution.range!);
      }

      const confirmItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        101
      );
      confirmItem.text = vscode.l10n.t(
        "$(check) Confirm CodeTour anchor rebind"
      );
      confirmItem.command = `${EXTENSION_NAME}.confirmAnchorRebind`;
      confirmItem.show();

      const cancelItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
      );
      cancelItem.text = vscode.l10n.t("$(close) Cancel CodeTour anchor rebind");
      cancelItem.command = `${EXTENSION_NAME}.cancelAnchorRebind`;
      cancelItem.show();
      pendingRebind = {
        tourId: tour.id,
        serializedStep: JSON.stringify(step),
        uri,
        confirmItem,
        cancelItem
      };
      const message =
        step.anchor.type === "symbol"
          ? vscode.l10n.t(
              "Place the cursor inside the target symbol, then confirm the anchor rebind."
            )
          : step.anchor.type === "content"
          ? vscode.l10n.t(
              "Select the target source text, then confirm the anchor rebind."
            )
          : vscode.l10n.t(
              "Place the cursor on the target line, then confirm the anchor rebind."
            );
      void vscode.window.showInformationMessage(message);
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.confirmAnchorRebind`,
    async () => {
      if (!pendingRebind) {
        return;
      }
      const { tourId, serializedStep, uri } = pendingRebind;
      const tour =
        store.activeTour?.tour.id === tourId
          ? store.activeTour.tour
          : store.tours.find(candidate => candidate.id === tourId);
      const matchingSteps = tour?.steps
        .map((step, index) => ({ step, index }))
        .filter(({ step }) => JSON.stringify(step) === serializedStep);
      if (!tour || matchingSteps?.length !== 1) {
        clearPendingRebind();
        return vscode.window.showWarningMessage(
          vscode.l10n.t(
            "The tour changed while rebinding. Start the rebind again."
          )
        );
      }
      const [{ step, index: stepNumber }] = matchingSteps;
      const editor = vscode.window.activeTextEditor;
      if (!editor || !step.anchor) {
        return;
      }
      if (editor.document.uri.toString() !== uri.toString()) {
        return vscode.window.showWarningMessage(
          vscode.l10n.t("Return to the original source file before confirming.")
        );
      }

      if (step.anchor.type === "content") {
        if (editor.selection.isEmpty) {
          return vscode.window.showWarningMessage(
            vscode.l10n.t("Select non-empty source text before confirming.")
          );
        }
        step.anchor.text = normalizeSelectedText(
          editor.document.getText(editor.selection)
        );
      } else if (step.anchor.type === "symbol") {
        const symbol = await anchorResolver.findSymbolAt(
          editor.document.uri,
          editor.selection.active
        );
        if (!symbol) {
          return vscode.window.showWarningMessage(
            vscode.l10n.t("No document symbol is available at the cursor.")
          );
        }
        step.anchor.path = symbol.path;
      } else {
        step.anchor.number = editor.selection.active.line + 1;
      }

      await saveTour(tour);
      await anchorResolver.resolveStep(tour, stepNumber);
      clearPendingRebind();
      void vscode.window.showInformationMessage(
        vscode.l10n.t("The CodeTour anchor was rebound successfully.")
      );
    }
  );

  registerCommand(`${EXTENSION_NAME}.cancelAnchorRebind`, () =>
    clearPendingRebind()
  );

  registerCommand(
    `${EXTENSION_NAME}.previewTour`,
    async (node: CodeTourNode | vscode.CommentThread) => {
      if (!(await commitActiveTourEdit())) {
        return;
      }

      if (node instanceof CodeTourNode) {
        const activeTour =
          store.activeTour?.tour.id === node.tour.id
            ? store.activeTour
            : undefined;
        startCodeTour(
          node.tour,
          activeTour?.step,
          activeTour?.workspaceRoot,
          false,
          isTourEditable(node.tour),
          activeTour?.tours
        );
      } else if (store.activeTour) {
        startCodeTour(
          store.activeTour.tour,
          store.activeTour.step,
          store.activeTour.workspaceRoot,
          false,
          store.activeTour.canEditTour !== false,
          store.activeTour.tours
        );
      }
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.makeTourPrimary`,
    async (node: CodeTourNode) => {
      if (
        !(node instanceof CodeTourNode) ||
        !ensureTourEditable(node.tour) ||
        !(await commitActiveTourEdit())
      ) {
        return;
      }
      const primaryTour = getCurrentTour(node.tour.id, node.tour);
      if (!primaryTour || !ensureTourEditable(primaryTour)) {
        return;
      }
      primaryTour.isPrimary = true;
      const previousPrimaryTours = store.tours.filter(
        tour => tour.id !== primaryTour.id && tour.isPrimary
      );
      previousPrimaryTours.forEach(tour => delete tour.isPrimary);
      await Promise.all([
        saveTour(primaryTour),
        ...previousPrimaryTours.map(saveTour)
      ]);
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.unmakeTourPrimary`,
    async (node: CodeTourNode) => {
      if (
        !(node instanceof CodeTourNode) ||
        !ensureTourEditable(node.tour) ||
        !(await commitActiveTourEdit())
      ) {
        return;
      }
      const primaryTour = getCurrentTour(node.tour.id, node.tour);
      if (!primaryTour || !ensureTourEditable(primaryTour)) {
        return;
      }
      delete primaryTour.isPrimary;
      await saveTour(primaryTour);
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.saveTourStep`,
    async (comment: CodeTourComment) => {
      await commitActiveTourEdit(comment);
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.cancelTourStepEdit`,
    async (comment?: CodeTourComment) => {
      await cancelActiveTourEdit(comment);
    }
  );

  async function updateTourProperty(
    initialTour: CodeTour,
    property: "title" | "description"
  ) {
    if (
      !ensureTourEditable(initialTour) ||
      !(await commitActiveTourEdit())
    ) {
      return;
    }
    const tourId = initialTour.id;
    let tour = getCurrentTour(tourId, initialTour);
    if (!tour || !ensureTourEditable(tour)) {
      return;
    }
    const propertyName =
      property === "title"
        ? vscode.l10n.t("title")
        : vscode.l10n.t("description");
    const propertyValue = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("Enter the {0} for this tour", propertyName),
      value: tour[property]
    });

    if (propertyValue === undefined || (property === "title" && !propertyValue)) {
      return;
    }

    const previousValue = tour[property];
    tour = getCurrentTour(tourId);
    if (!tour || !ensureTourEditable(tour)) {
      warnTourChanged();
      return;
    }
    if (propertyValue) {
      tour[property] = propertyValue;
    } else {
      delete tour[property];
    }
    await saveTour(tour);

    return { previousValue, propertyValue };
  }

  async function updateTourStepProperty(
    node: CodeTourStepNode,
    property: "title" | "icon"
  ) {
    if (!ensureTourEditable(node.tour)) {
      return;
    }
    const requestedStep = node.tour.steps[node.stepNumber];
    if (!requestedStep || !(await commitActiveTourEdit())) {
      return;
    }
    const tourId = node.tour.id;
    let tour = getCurrentTour(tourId, node.tour);
    if (!tour || !ensureTourEditable(tour)) {
      return;
    }
    let stepNumber: number | undefined = tour.steps.indexOf(requestedStep);
    if (stepNumber < 0) {
      stepNumber = findMatchingStep(
        tour,
        JSON.stringify(requestedStep),
        node.stepNumber
      );
    }
    if (stepNumber === undefined || stepNumber < 0) {
      warnTourChanged();
      return;
    }
    const serializedStep = JSON.stringify(tour.steps[stepNumber]);
    const response = await vscode.window.showInputBox({
      prompt:
        property === "title"
          ? vscode.l10n.t("Enter the title for this tour step")
          : vscode.l10n.t("Enter the icon for this tour step"),
      value: tour.steps[stepNumber][property] || ""
    });

    if (response === undefined) {
      return;
    }
    tour = getCurrentTour(tourId);
    if (!tour || !ensureTourEditable(tour)) {
      warnTourChanged();
      return;
    }
    stepNumber = findMatchingStep(tour, serializedStep, stepNumber);
    if (stepNumber === undefined) {
      warnTourChanged();
      return;
    }
    const step = tour.steps[stepNumber];
    if (response) {
      step[property] = response;
    } else {
      delete step[property];
    }
    await saveTour(tour);
  }

  async function moveStep(
    movement: number,
    node: CodeTourStepNode | CodeTourComment
  ) {
    let tour: CodeTour, stepNumber: number;
    let requestedStep: CodeTourStep;

    if (node instanceof CodeTourComment) {
      if (!store.activeTour || store.activeTour.canEditTour === false) {
        return;
      }
      tour = store.activeTour.tour;
      stepNumber = store.activeTour.step;
    } else if (node instanceof CodeTourStepNode) {
      tour = node.tour;
      stepNumber = node.stepNumber;
    } else {
      return;
    }

    requestedStep = tour.steps[stepNumber];
    if (!requestedStep || !(await commitActiveTourEdit())) {
      return;
    }
    stepNumber = tour.steps.indexOf(requestedStep);

    if (
      !ensureTourEditable(tour) ||
      stepNumber < 0 ||
      stepNumber >= tour.steps.length ||
      stepNumber + movement < 0 ||
      stepNumber + movement >= tour.steps.length
    ) {
      return;
    }

    const activeStep =
      store.activeTour?.tour.id === tour.id
        ? store.activeTour.tour.steps[store.activeTour.step]
        : undefined;
    runInAction(() => {
      const step = tour.steps[stepNumber];
      tour.steps.splice(stepNumber, 1);
      tour.steps.splice(stepNumber + movement, 0, step);

      // If the user is moving the currently active step, then move
      // the tour play along with it as well.
      if (store.activeTour?.tour.id === tour.id && activeStep) {
        store.activeTour.step = tour.steps.indexOf(activeStep);
      }
    });
    await saveTour(tour);
  }

  registerCommand(
    `${EXTENSION_NAME}.moveTourStepBack`,
    moveStep.bind(null, -1)
  );

  registerCommand(
    `${EXTENSION_NAME}.moveTourStepForward`,
    moveStep.bind(null, 1)
  );

  registerCommand(
    `${EXTENSION_NAME}.changeTourDescription`,
    (node: CodeTourNode) =>
      node instanceof CodeTourNode
        ? updateTourProperty(node.tour, "description")
        : undefined
  );

  registerCommand(
    `${EXTENSION_NAME}.changeTourTitle`,
    async (node: CodeTourNode) => {
      if (!(node instanceof CodeTourNode) || !ensureTourEditable(node.tour)) {
        return;
      }
      const result = await updateTourProperty(node.tour, "title");

      // If the user updated the tour's title, then we need to check
      // whether there are other tours that reference this tour, and
      // if so, we want to update the tour reference to match the new title.
      if (result) {
        const referencingTours = store.tours.filter(
          tour => tour.nextTour === result.previousValue
        );
        referencingTours.forEach(
          tour => (tour.nextTour = result.propertyValue)
        );
        await Promise.all(referencingTours.map(saveTour));
      }
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.changeTourStepTitle`,
    (node: CodeTourStepNode) =>
      node instanceof CodeTourStepNode
        ? updateTourStepProperty(node, "title")
        : undefined
  );

  registerCommand(
    `${EXTENSION_NAME}.changeTourStepIcon`,
    (node: CodeTourStepNode) =>
      node instanceof CodeTourStepNode
        ? updateTourStepProperty(node, "icon")
        : undefined
  );

  registerCommand(
    `${EXTENSION_NAME}.changeTourStepLine`,
    async (comment: CodeTourComment) => {
      if (!store.activeTour || store.activeTour.canEditTour === false) {
        return;
      }
      if (!(await commitActiveTourEdit(comment))) {
        return;
      }
      const activeTour = store.activeTour;
      if (!activeTour || activeTour.canEditTour === false) {
        return;
      }
      const tourId = activeTour.tour.id;
      const stepNumber = activeTour.step;
      const step = activeTour.tour.steps[stepNumber];
      if (step.anchor?.type !== "line") {
        return;
      }
      const serializedStep = JSON.stringify(step);
      const response = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Enter the new line number for this tour step."),
        value: step.anchor.number.toString(),
        validateInput: value =>
          Number.isInteger(Number(value)) && Number(value) > 0
            ? undefined
            : vscode.l10n.t("Enter a positive integer line number.")
      });

      if (!response) {
        return;
      }
      const currentTour = getCurrentTour(tourId);
      if (!currentTour || !ensureTourEditable(currentTour)) {
        warnTourChanged();
        return;
      }
      const currentStepNumber = findMatchingStep(
        currentTour,
        serializedStep,
        stepNumber
      );
      if (currentStepNumber === undefined) {
        warnTourChanged();
        return;
      }
      const currentStep = currentTour.steps[currentStepNumber];
      if (currentStep.anchor?.type !== "line") {
        warnTourChanged();
        return;
      }
      currentStep.anchor.number = Number(response);

      await saveTour(currentTour);
      await anchorResolver.resolveStep(currentTour, currentStepNumber);
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.changeTourRef`,
    async (node: CodeTourNode) => {
      if (
        !(node instanceof CodeTourNode) ||
        !ensureTourEditable(node.tour) ||
        !(await commitActiveTourEdit())
      ) {
        return;
      }
      const tourId = node.tour.id;
      let tour = getCurrentTour(tourId, node.tour);
      if (!tour || !ensureTourEditable(tour)) {
        return;
      }
      const workspaceRoot =
        store.activeTour &&
        store.activeTour.tour.id === tourId &&
        store.activeTour.workspaceRoot
          ? store.activeTour.workspaceRoot
          : workspace.getWorkspaceFolder(vscode.Uri.parse(node.tour.id))?.uri;

      if (!workspaceRoot) {
        return vscode.window.showErrorMessage(
          vscode.l10n.t(
            "The Git ref of an embedded tour file cannot be changed."
          )
        );
      }

      const ref = await promptForTourRef(workspaceRoot);
      if (ref === CANCELLED_GIT_REF) {
        return;
      }
      tour = getCurrentTour(tourId);
      if (!tour || !ensureTourEditable(tour)) {
        warnTourChanged();
        return;
      }
      if (ref) {
        if (ref === "HEAD") {
          delete tour.ref;
        } else {
          tour.ref = ref;
        }
      }

      await saveTour(tour);
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.deleteTour`,
    async (node: CodeTourNode, additionalNodes: unknown[]) => {
      const rawNodes = additionalNodes || [node];
      if (rawNodes.some(candidate => !(candidate instanceof CodeTourNode))) {
        return;
      }
      const selectedNodes = rawNodes.filter(
        (candidate): candidate is CodeTourNode => candidate instanceof CodeTourNode
      );
      const uniqueNodes = Array.from(
        new Map(selectedNodes.map(candidate => [candidate.tour.id, candidate])).values()
      );
      if (
        uniqueNodes.length === 0 ||
        uniqueNodes.some(candidate => !isTourEditable(candidate.tour))
      ) {
        return;
      }
      const isMultiSelection = uniqueNodes.length > 1;
      const messageSuffix = isMultiSelection
        ? vscode.l10n.t("{0} selected tours", uniqueNodes.length)
        : vscode.l10n.t('tour "{0}"', uniqueNodes[0].tour.title);
      const deleteButton = isMultiSelection
        ? vscode.l10n.t("Delete Tours")
        : vscode.l10n.t("Delete Tour");

      if (
        await vscode.window.showInformationMessage(
          vscode.l10n.t("Delete {0}?", messageSuffix),
          deleteButton
        )
      ) {
        const tourIds = uniqueNodes.map(candidate => candidate.tour.id);

        if (store.activeTour && tourIds.includes(store.activeTour.tour.id)) {
          if (!(await endCurrentCodeTour())) {
            return;
          }
        }

        await Promise.all(
          tourIds.map(tourId =>
            vscode.workspace.fs.delete(vscode.Uri.parse(tourId))
          )
        );
        runInAction(() => {
          store.tours = store.tours.filter(tour => !tourIds.includes(tour.id));
        });
        await vscode.commands.executeCommand(
          "setContext",
          `${EXTENSION_NAME}:hasTours`,
          store.hasTours
        );
      }
    }
  );

  registerCommand(
    `${EXTENSION_NAME}.deleteTourStep`,
    async (
      node: CodeTourStepNode | CodeTourComment,
      additionalNodes: unknown[]
    ) => {
      let tour: CodeTour, steps: number[];
      let messageSuffix = vscode.l10n.t("the selected step");
      let deleteButton = vscode.l10n.t("Delete Step");

      if (node instanceof CodeTourStepNode) {
        tour = node.tour;

        if (additionalNodes) {
          if (
            additionalNodes.some(
              candidate =>
                !(candidate instanceof CodeTourStepNode) ||
                candidate.tour.id !== tour.id
            )
          ) {
            return;
          }
          const selectedSteps = additionalNodes.filter(
            (candidate): candidate is CodeTourStepNode =>
              candidate instanceof CodeTourStepNode &&
              candidate.tour.id === tour.id
          );
          if (selectedSteps.length === 0) {
            selectedSteps.push(node);
          }
          deleteButton = vscode.l10n.t("Delete Steps");
          messageSuffix = vscode.l10n.t(
            "{0} selected steps",
            selectedSteps.length
          );

          steps = selectedSteps.map(n => n.stepNumber);
        } else {
          steps = [node.stepNumber];
        }
      } else if (node instanceof CodeTourComment && store.activeTour) {
        tour = store.activeTour.tour;
        steps = [store.activeTour.step];
      } else {
        return;
      }

      if (!ensureTourEditable(tour)) {
        return;
      }

      const requestedSteps = steps
        .map(stepNumber => ({
          step: tour.steps[stepNumber],
          preferredIndex: stepNumber
        }))
        .filter(
          (request): request is { step: CodeTourStep; preferredIndex: number } =>
            !!request.step
        );
      const tourId = tour.id;

      if (
        await vscode.window.showInformationMessage(
          vscode.l10n.t("Delete {0}?", messageSuffix),
          deleteButton
        )
      ) {
        if (!(await commitActiveTourEdit())) {
          return;
        }
        const currentTour = getCurrentTour(tourId);
        if (!currentTour || !ensureTourEditable(currentTour)) {
          warnTourChanged();
          return;
        }
        const usedStepNumbers = new Set<number>();
        const uniqueSteps = Array.from(
          new Set(
            requestedSteps.map(({ step, preferredIndex }) => {
              const identityIndex = currentTour.steps.indexOf(step);
              if (identityIndex >= 0 && !usedStepNumbers.has(identityIndex)) {
                usedStepNumbers.add(identityIndex);
                return identityIndex;
              }
              const serializedStep = JSON.stringify(step);
              const matchingIndex = currentTour.steps
                .map((candidate, index) => ({ candidate, index }))
                .filter(
                  ({ candidate, index }) =>
                    !usedStepNumbers.has(index) &&
                    JSON.stringify(candidate) === serializedStep
                )
                .sort(
                  (left, right) =>
                    Math.abs(left.index - preferredIndex) -
                    Math.abs(right.index - preferredIndex)
                )[0]?.index;
              if (matchingIndex !== undefined) {
                usedStepNumbers.add(matchingIndex);
              }
              return matchingIndex;
            })
            .filter(
              (stepNumber): stepNumber is number => stepNumber !== undefined
            )
          )
        )
          .sort((left, right) => right - left);
        if (uniqueSteps.length !== requestedSteps.length) {
          warnTourChanged();
          return;
        }
        const activeStep =
          store.activeTour?.tour.id === tourId
            ? store.activeTour.step
            : undefined;
        const deletedActiveStep =
          activeStep !== undefined && uniqueSteps.includes(activeStep);
        uniqueSteps.forEach(step => currentTour.steps.splice(step, 1));

        if (node instanceof CodeTourComment) {
          node.parent.dispose();
        }

        if (store.activeTour && store.activeTour.tour.id === tourId) {
          const removedBefore = uniqueSteps.filter(
            step => step < (activeStep as number)
          ).length;
          store.activeTour.step = Math.min(
            Math.max((activeStep as number) - removedBefore, 0),
            currentTour.steps.length - 1
          );

          if (deletedActiveStep) {
            // The only reason that a CodeTour content editor would be
            // open is because it was associated with the current step.
            // So detect if there are any, and if so, hide them.
            vscode.window.visibleTextEditors.forEach(editor => {
              if (editor.document.uri.scheme === FS_SCHEME_CONTENT) {
                editor.hide();
              }
            });
          }
        }

        await saveTour(currentTour);
      }
    }
  );

  interface GitRefQuickPickItem extends vscode.QuickPickItem {
    ref?: string;
  }

  const CANCELLED_GIT_REF = Symbol("cancelledGitRef");

  async function promptForTourRef(
    workspaceRoot: vscode.Uri
  ): Promise<string | undefined | typeof CANCELLED_GIT_REF> {
    // If for some reason the Git extension isn't available,
    // then we won't be able to ask the user to select a git ref.
    if (!api || !api.getRepository) {
      return;
    }

    const repository = api.getRepository(workspaceRoot);

    // The opened project isn't a git repository, and
    // so there's no commit/tag/branch to associate the tour with.
    if (!repository) {
      return;
    }

    const head = repository.state.HEAD;
    const currentBranch = head?.name;
    let items: GitRefQuickPickItem[] = [
      {
        label: vscode.l10n.t("$(circle-slash) None"),
        description: vscode.l10n.t(
          "Allow the tour to apply to all versions of this repository"
        ),
        ref: "HEAD",
        alwaysShow: true
      }
    ];
    if (currentBranch) {
      items.push({
        label: vscode.l10n.t(
          "$(git-branch) Current branch ({0})",
          currentBranch
        ),
        description: vscode.l10n.t(
          "Allow the tour to apply to all versions of this branch"
        ),
        ref: currentBranch,
        alwaysShow: true
      });
    }
    if (head?.commit) {
      items.push({
        label: vscode.l10n.t("$(git-commit) Current commit"),
        description: vscode.l10n.t(
          "Keep the tour associated with a specific commit"
        ),
        ref: head.commit,
        alwaysShow: true
      });
    }

    const tags = repository.state.refs
      .filter(ref => ref.type === RefType.Tag)
      .map(ref => ref.name!)
      .sort()
      .map(ref => ({
        label: `$(tag) ${ref}`,
        description: vscode.l10n.t(
          "Keep the tour associated with a specific tag"
        ),
        ref
      }));

    if (tags.length > 0) {
      items.push(...tags);
    }

    const response = await vscode.window.showQuickPick<GitRefQuickPickItem>(
      items,
      {
        placeHolder: vscode.l10n.t(
          "Select the Git ref to associate with the tour"
        )
      }
    );

    return response ? response.ref : CANCELLED_GIT_REF;
  }
}
