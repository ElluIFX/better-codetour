// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { action, runInAction } from "mobx";
import * as path from "path";
import * as vscode from "vscode";
import { workspace } from "vscode";
import { anchorResolver } from "../anchors";
import { EXTENSION_NAME, FS_SCHEME_CONTENT } from "../constants";
import { api, RefType } from "../git";
import { CodeTourComment } from "../player";
import { CodeTourNode, CodeTourStepNode } from "../player/tree/nodes";
import { CodeTour, CodeTourStep, store } from "../store";
import { saveTour } from "../store/persistence";
import {
  EDITING_KEY,
  endCurrentCodeTour,
  exportTour,
  onDidEndTour,
  startCodeTour
} from "../store/actions";
import { getActiveWorkspacePath, getRelativePath } from "../utils";

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

export function registerRecorderCommands() {
  let pendingRebind:
    | {
        tour: CodeTour;
        stepNumber: number;
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

  async function insertAnchoredStep(
    editor: vscode.TextEditor,
    anchor: NonNullable<CodeTourStep["anchor"]>
  ) {
    if (!store.activeTour || !store.isRecording) {
      return;
    }
    const stepNumber = ++store.activeTour.step;
    const tour = store.activeTour.tour;
    const file = getRelativePath(
      getActiveWorkspacePath(),
      editor.document.uri.path
    );
    tour.steps.splice(stepNumber, 0, {
      file,
      anchor,
      description: ""
    });
    store.isEditing = true;
    await vscode.commands.executeCommand("setContext", EDITING_KEY, true);
    await saveTour(tour);
    await anchorResolver.resolveStep(tour, stepNumber);
  }

  function clearPendingRebind() {
    pendingRebind?.confirmItem.dispose();
    pendingRebind?.cancelItem.dispose();
    pendingRebind = undefined;
  }

  onDidEndTour(clearPendingRebind);

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
    const tourDirectory = customTourDirectory || ".tours";

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
  ) {
    if (!workspaceRoot) {
      workspaceRoot = workspace.workspaceFolders![0].uri;

      if (workspace.workspaceFolders!.length > 1) {
        const items: WorkspaceQuickPickItem[] = workspace.workspaceFolders!.map(
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
          return vscode.commands.executeCommand(
            `${EXTENSION_NAME}.recordTour`,
            workspaceRoot,
            tourTitle
          );
        } else if (!response) {
          // If the end-user closes the error
          // dialog, then cancel the recording.
          return;
        }
      }
    }

    const ref = await promptForTourRef(workspaceRoot);

    const tour = await writeTourFile(workspaceRoot, tourTitle, ref);

    startCodeTour(tour, undefined, workspaceRoot, true);

    vscode.window.showInformationMessage(
      vscode.l10n.t(
        "CodeTour recording started. Open a file and use its gutter plus button or editor context menu to add steps."
      )
    );
  }

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.recordTour`,
    async (workspaceRoot?: vscode.Uri, placeHolderTitle?: string) => {
      const inputBox = vscode.window.createInputBox();
      inputBox.title = vscode.l10n.t(
        "Specify the tour title or save it to a specific location"
      );
      inputBox.placeholder = placeHolderTitle;
      inputBox.buttons = [
        {
          iconPath: new vscode.ThemeIcon("save-as"),
          tooltip: vscode.l10n.t("Save tour as...")
        }
      ];

      inputBox.onDidAccept(async () => {
        inputBox.hide();

        if (!inputBox.value) {
          return;
        }

        await recordTourInternal(inputBox.value, workspaceRoot);
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

        await recordTourInternal(uri, workspaceRoot);
      });

      inputBox.show();
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.addContentStep`,
    action(async (node?: CodeTourStepNode) => {
      const value =
        store.activeTour?.step === -1 ? vscode.l10n.t("Introduction") : "";
      const title = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Specify the title of the step"),
        value
      });

      if (!title) {
        return;
      }

      let stepNumber;
      if (node) {
        stepNumber = node.stepNumber + 1;
        store.activeTour!.step = stepNumber;
      } else {
        stepNumber = ++store.activeTour!.step;
      }

      const tour = store.activeTour!.tour;

      tour.steps.splice(stepNumber, 0, {
        title,
        description: ""
      });

      if (!store.isEditing) {
        store.isEditing = true;
        await vscode.commands.executeCommand("setContext", EDITING_KEY, true);
      }

      await saveTour(tour);
    })
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.addDirectoryStep`,
    action(async (uri: vscode.Uri) => {
      const stepNumber = ++store.activeTour!.step;
      const tour = store.activeTour!.tour;

      const workspaceRoot = getActiveWorkspacePath();
      const directory = getRelativePath(workspaceRoot, uri.path);

      tour.steps.splice(stepNumber, 0, {
        directory,
        description: ""
      });

      if (!store.isEditing) {
        store.isEditing = true;
        await vscode.commands.executeCommand("setContext", EDITING_KEY, true);
      }

      await saveTour(tour);
    })
  );

  vscode.commands.registerTextEditorCommand(
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

  vscode.commands.registerTextEditorCommand(
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

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.addTourStep`,
    action(async (reply: vscode.CommentReply) => {
      if (store.activeTour!.thread) {
        store.activeTour!.thread.dispose();
      }

      store.activeTour!.thread = reply.thread;

      const tour = store.activeTour!.tour;
      const thread = store.activeTour!.thread;

      const workspaceRoot = getActiveWorkspacePath();
      const file = getRelativePath(workspaceRoot, thread!.uri.path);

      const step: CodeTourStep = {
        file,
        description: reply.text
      };

      const selected = getNonEmptySelection(thread!.uri);
      step.anchor = getGutterStepAnchor(
        selected?.editor.document ||
          (await workspace.openTextDocument(thread!.uri)),
        selected?.selection,
        thread!.range.start.line
      );

      store.activeTour!.step++;

      const stepNumber = store.activeTour!.step;

      thread!.dispose();
      store.activeTour!.thread = null;
      tour.steps.splice(stepNumber, 0, step);

      store.isEditing = false;
      await vscode.commands.executeCommand("setContext", EDITING_KEY, false);

      await saveTour(tour);
      await anchorResolver.resolveStep(tour, stepNumber);
    })
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.editTour`,
    async (node: CodeTourNode | vscode.CommentThread) => {
      store.isRecording = true;
      store.isEditing = true;
      await vscode.commands.executeCommand(
        "setContext",
        "codetour:recording",
        true
      );
      await vscode.commands.executeCommand("setContext", EDITING_KEY, true);

      if (node instanceof CodeTourNode) {
        startCodeTour(node.tour);
      } else if (store.activeTour) {
        // We need to re-start the tour so that the associated
        // comment controller is put into edit mode
        startCodeTour(
          store.activeTour!.tour,
          store.activeTour!.step,
          store.activeTour.workspaceRoot
        );
      }
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.editTourAtStep`,
    async (node: CodeTourStepNode) => {
      startCodeTour(node.tour, node.stepNumber, undefined, true);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.rebindTourStepAnchor`,
    async (node?: CodeTourStepNode) => {
      const tour = node?.tour || store.activeTour?.tour;
      const stepNumber = node?.stepNumber ?? store.activeTour?.step;
      if (!tour || stepNumber === undefined || stepNumber < 0) {
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
        tour,
        stepNumber,
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

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.confirmAnchorRebind`,
    async () => {
      if (!pendingRebind) {
        return;
      }
      const { tour, stepNumber, uri } = pendingRebind;
      const step = tour.steps[stepNumber];
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

  vscode.commands.registerCommand(`${EXTENSION_NAME}.cancelAnchorRebind`, () =>
    clearPendingRebind()
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.previewTour`,
    async (node: CodeTourNode | vscode.CommentThread) => {
      store.isRecording = false;
      store.isEditing = false;
      await vscode.commands.executeCommand("setContext", EDITING_KEY, false);
      await vscode.commands.executeCommand(
        "setContext",
        "codetour:recording",
        false
      );

      if (node instanceof CodeTourNode) {
        startCodeTour(node.tour);
      } else if (store.activeTour) {
        // We need to re-start the tour so that the associated
        // comment controller is put into edit mode
        startCodeTour(
          store.activeTour!.tour,
          store.activeTour!.step,
          store.activeTour.workspaceRoot
        );
      }
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.makeTourPrimary`,
    async (node: CodeTourNode) => {
      const primaryTour = node.tour;
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

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.unmakeTourPrimary`,
    async (node: CodeTourNode) => {
      const primaryTour = node.tour;
      delete primaryTour.isPrimary;
      await saveTour(primaryTour);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.saveTourStep`,
    async (comment: CodeTourComment) => {
      if (!comment.parent) {
        return;
      }

      runInAction(() => {
        const content =
          comment.body instanceof vscode.MarkdownString
            ? comment.body.value
            : comment.body;

        const tourStep = store.activeTour!.tour!.steps[store.activeTour!.step];
        tourStep.description = content;
      });

      store.isEditing = false;
      await vscode.commands.executeCommand("setContext", EDITING_KEY, false);
      await saveTour(store.activeTour!.tour);
    }
  );

  async function updateTourProperty(tour: CodeTour, property: string) {
    const propertyName =
      property === "title"
        ? vscode.l10n.t("title")
        : vscode.l10n.t("description");
    const propertyValue = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("Enter the {0} for this tour", propertyName),
      // @ts-ignore
      value: tour[property]
    });

    if (!propertyValue) {
      return;
    }

    // @ts-ignore
    tour[property] = propertyValue;
    await saveTour(tour);

    return propertyValue;
  }

  function moveStep(
    movement: number,
    node: CodeTourStepNode | CodeTourComment
  ) {
    let tour: CodeTour, stepNumber: number;

    if (node instanceof CodeTourComment) {
      tour = store.activeTour!.tour;
      stepNumber = store.activeTour!.step;
    } else {
      tour = node.tour;
      stepNumber = node.stepNumber;
    }

    runInAction(async () => {
      const step = tour.steps[stepNumber];
      tour.steps.splice(stepNumber, 1);
      tour.steps.splice(stepNumber + movement, 0, step);

      // If the user is moving the currently active step, then move
      // the tour play along with it as well.
      if (
        store.activeTour &&
        tour.id === store.activeTour.tour.id &&
        stepNumber === store.activeTour.step
      ) {
        store.activeTour.step += movement;
      }

      await saveTour(tour);
    });
  }

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.moveTourStepBack`,
    moveStep.bind(null, -1)
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.moveTourStepForward`,
    moveStep.bind(null, 1)
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourDescription`,
    (node: CodeTourNode) => updateTourProperty(node.tour, "description")
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourTitle`,
    async (node: CodeTourNode) => {
      const oldTitle = node.tour.title;
      const newTitle = await updateTourProperty(node.tour, "title");

      // If the user updated the tour's title, then we need to check
      // whether there are other tours that reference this tour, and
      // if so, we want to update the tour reference to match the new title.
      if (newTitle) {
        const referencingTours = store.tours.filter(
          tour => tour.nextTour === oldTitle
        );
        referencingTours.forEach(tour => (tour.nextTour = newTitle));
        await Promise.all(referencingTours.map(saveTour));
      }
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourStepTitle`,
    async (node: CodeTourStepNode) => {
      const step = node.tour.steps[node.stepNumber];
      const response = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Enter the title for this tour step"),
        value: step.title || ""
      });

      if (typeof response === "undefined") {
        return;
      } else if (response) {
        step.title = response;
      } else {
        delete step.title;
      }

      await saveTour(node.tour);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourStepIcon`,
    async (node: CodeTourStepNode) => {
      const step = node.tour.steps[node.stepNumber];
      const response = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Enter the icon for this tour step"),
        value: step.icon || ""
      });

      if (typeof response === "undefined") {
        return;
      } else if (response) {
        step.icon = response;
      } else {
        delete step.icon;
      }

      await saveTour(node.tour);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourStepLine`,
    async (comment: CodeTourComment) => {
      const step = store.activeTour!.tour.steps[store.activeTour!.step];
      if (step.anchor?.type !== "line") {
        return;
      }
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
      step.anchor.number = Number(response);

      await saveTour(store.activeTour!.tour);
      await anchorResolver.resolveStep(
        store.activeTour!.tour,
        store.activeTour!.step
      );
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourRef`,
    async (node: CodeTourNode) => {
      const workspaceRoot =
        store.activeTour &&
        store.activeTour.tour.id === node.tour.id &&
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
      if (ref) {
        if (ref === "HEAD") {
          delete node.tour.ref;
        } else {
          node.tour.ref = ref;
        }
      }

      await saveTour(node.tour);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.deleteTour`,
    async (node: CodeTourNode, additionalNodes: CodeTourNode[]) => {
      const messageSuffix = additionalNodes
        ? vscode.l10n.t("{0} selected tours", additionalNodes.length)
        : vscode.l10n.t('tour "{0}"', node.tour.title);
      const deleteButton = additionalNodes
        ? vscode.l10n.t("Delete Tours")
        : vscode.l10n.t("Delete Tour");

      if (
        await vscode.window.showInformationMessage(
          vscode.l10n.t("Delete {0}?", messageSuffix),
          deleteButton
        )
      ) {
        const tourIds = (additionalNodes || [node]).map(node => node.tour.id);

        if (store.activeTour && tourIds.includes(store.activeTour.tour.id)) {
          await endCurrentCodeTour();
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

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.deleteTourStep`,
    async (
      node: CodeTourStepNode | CodeTourComment,
      additionalNodes: CodeTourStepNode[]
    ) => {
      let tour: CodeTour, steps: number[];
      let messageSuffix = vscode.l10n.t("the selected step");
      let deleteButton = vscode.l10n.t("Delete Step");

      if (node instanceof CodeTourStepNode) {
        tour = node.tour;

        if (additionalNodes) {
          deleteButton = vscode.l10n.t("Delete Steps");
          messageSuffix = vscode.l10n.t(
            "{0} selected steps",
            additionalNodes.length
          );

          steps = additionalNodes.map(n => n.stepNumber);
        } else {
          steps = [node.stepNumber];
        }
      } else {
        tour = store.activeTour!.tour;
        steps = [store.activeTour!.step];
      }

      if (
        await vscode.window.showInformationMessage(
          vscode.l10n.t("Delete {0}?", messageSuffix),
          deleteButton
        )
      ) {
        const uniqueSteps = Array.from(new Set(steps)).sort(
          (left, right) => right - left
        );
        const activeStep =
          store.activeTour?.tour.id === tour.id
            ? store.activeTour.step
            : undefined;
        const deletedActiveStep =
          activeStep !== undefined && uniqueSteps.includes(activeStep);
        uniqueSteps.forEach(step => tour.steps.splice(step, 1));

        if (node instanceof CodeTourComment) {
          node.parent.dispose();
        }

        if (store.activeTour && store.activeTour.tour.id === tour.id) {
          const removedBefore = uniqueSteps.filter(
            step => step < (activeStep as number)
          ).length;
          store.activeTour.step = Math.min(
            Math.max((activeStep as number) - removedBefore, 0),
            tour.steps.length - 1
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

        await saveTour(tour);
      }
    }
  );

  interface GitRefQuickPickItem extends vscode.QuickPickItem {
    ref?: string;
  }

  async function promptForTourRef(
    workspaceRoot: vscode.Uri
  ): Promise<string | undefined> {
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

    if (response) {
      return response.ref;
    }
  }
}
