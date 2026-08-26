// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { reaction } from "mobx";
import {
  commands,
  Comment,
  CommentAuthorInformation,
  CommentController,
  CommentMode,
  comments,
  CommentThread,
  CommentThreadCollapsibleState,
  ExtensionContext,
  l10n,
  MarkdownString,
  Range,
  Selection,
  TextDocument,
  TextEditorRevealType,
  Uri,
  window,
  workspace
} from "vscode";
import { SMALL_ICON_URL } from "../constants";
import { anchorResolver } from "../anchors";
import { CodeTour, store } from "../store";
import { initializeStorage } from "../store/storage";
import {
  getActiveTourNumber,
  getFileUri,
  getStepFileUri,
  getStepLabel,
  getTourTitle,
  getWorkspaceUri
} from "../utils";
import { registerCodeStatusModule } from "./codeStatus";
import { registerPlayerCommands } from "./commands";
import { registerDecorators } from "./decorator";
import { registerFileSystemProvider } from "./fileSystem";
import { registerTextDocumentContentProvider } from "./fileSystem/documentProvider";
import { registerStatusBar } from "./status";
import { registerTreeProvider } from "./tree";

const CONTROLLER_ID = "codetour";
const CONTROLLER_LABEL = "CodeTour";

let id = 0;

const SHELL_SCRIPT_PATTERN = /^>>\s+(?<script>.*)$/gm;

const COMMAND_PATTERN =
  /(?<commandPrefix>\(command:[\w+\.]+\?)(?<params>\[[^\]\)]+\])/gm;

const TOUR_REFERENCE_PATTERN =
  /(?:\[(?<linkTitle>[^\]]+)\])?\[(?=\s*[^\]\s])(?<tourTitle>[^\]#]+)?(?:#(?<stepNumber>\d+))?\](?!\()/gm;
const FILE_REFERENCE_PATTERN = /(\!)?(\[[^\]]+\]\()(\.[^\)]+)(?=\))/gm;
const CODE_FENCE_PATTERN = /```[^\n]+\n(.+)\n```/gms;

export function generatePreviewContent(
  content: string,
  contextTour?: CodeTour
) {
  return content
    .replace(SHELL_SCRIPT_PATTERN, (_, script) => {
      const args = encodeURIComponent(JSON.stringify([script]));
      const tooltip = l10n
        .t('Run "{0}" in a terminal', script.replace(/"/g, "'"))
        .replace(/"/g, '\\"');
      const s = `> [${script}](command:codetour.sendTextToTerminal?${args} "${tooltip}")`;
      return s;
    })
    .replace(COMMAND_PATTERN, (match, commandPrefix, params) => {
      try {
        const args = encodeURIComponent(JSON.stringify(JSON.parse(params)));
        return `${commandPrefix}${args}`;
      } catch {
        return match;
      }
    })
    .replace(FILE_REFERENCE_PATTERN, (match, isImage, prefix, filePath) => {
      const tour = contextTour || store.activeTour?.tour;
      const workspaceUri =
        tour && store.activeTour?.tour.id === tour.id
          ? store.activeTour.workspaceRoot
          : tour
          ? getWorkspaceUri(tour)
          : undefined;
      if (!workspaceUri) {
        return match;
      }
      const fileUri = Uri.joinPath(workspaceUri, filePath);

      if (isImage) {
        return `!${prefix}${fileUri.toString()}`;
      } else {
        const args = encodeURIComponent(JSON.stringify([fileUri]));
        return `${prefix}command:vscode.open?${args} "${l10n.t(
          "Open {0}",
          filePath
        )}"`;
      }
    })
    .replace(TOUR_REFERENCE_PATTERN, (_, linkTitle, tourTitle, stepNumber) => {
      if (!tourTitle) {
        const title = linkTitle || `#${stepNumber}`;
        return `[${title}](command:codetour.navigateToStep?${stepNumber} "${l10n.t(
          "Navigate to step #{0}",
          stepNumber
        )}")`;
      }

      const tours = store.activeTour?.tours || store.tours;
      const tour = tours.find(tour => getTourTitle(tour) === tourTitle);
      if (tour) {
        const args: [string, number?] = [tour.title];

        if (stepNumber) {
          args.push(Number(stepNumber));
        }
        const argsContent = encodeURIComponent(JSON.stringify(args));
        const title = linkTitle || tour.title;
        const tooltip = l10n
          .t('Start "{0}" tour', tour.title)
          .replace(/"/g, '\\"');
        return `[${title}](command:codetour.startTourByTitle?${argsContent} "${tooltip}")`;
      }

      return _;
    })
    .replace(CODE_FENCE_PATTERN, (_, codeBlock) => {
      const params = encodeURIComponent(JSON.stringify([codeBlock]));
      const insertCode = l10n.t("Insert Code");
      return `${_}
↪ [${insertCode}](command:codetour.insertCodeSnippet?${params} "${insertCode}")`;
    });
}

export class CodeTourComment implements Comment {
  public id: string = (++id).toString();
  public contextValue: string = "";
  public author: CommentAuthorInformation = {
    name: CONTROLLER_LABEL,
    iconPath: Uri.parse(SMALL_ICON_URL)
  };
  public body: MarkdownString;

  constructor(
    content: string,
    public label: string = "",
    public parent: CommentThread,
    public mode: CommentMode
  ) {
    const body =
      mode === CommentMode.Preview ? generatePreviewContent(content) : content;

    this.body = new MarkdownString(body);
    this.body.isTrusted = true;
  }
}

let controller: CommentController | null;
let renderGeneration = 0;
let lastUnresolvedNotice: string | undefined;

export async function focusPlayer() {
  const currentThread = store.activeTour!.thread!;
  showDocument(currentThread.uri, currentThread.range);
}

export function getRecordingCommentingRanges(
  document: TextDocument,
  selection?: Selection
) {
  if (!selection || selection.isEmpty) {
    return [
      new Range(
        document.lineAt(0).range.start,
        document.lineAt(document.lineCount - 1).range.end
      )
    ];
  }

  const selectedEndLine =
    selection.end.character === 0 && selection.end.line > selection.start.line
      ? selection.end.line - 1
      : selection.end.line;
  const ranges = [selection];
  if (selection.start.line > 0) {
    ranges.push(
      new Selection(
        document.lineAt(0).range.start,
        document.lineAt(selection.start.line - 1).range.end
      )
    );
  }
  if (selectedEndLine < document.lineCount - 1) {
    ranges.push(
      new Selection(
        document.lineAt(selectedEndLine + 1).range.start,
        document.lineAt(document.lineCount - 1).range.end
      )
    );
  }
  return ranges;
}

function updateCommentingRangeProvider() {
  if (!controller) {
    return;
  }
  controller.commentingRangeProvider = {
    provideCommentingRanges: (document: TextDocument) => {
      if (!store.isRecording) {
        return null;
      }
      const editor = window.visibleTextEditors.find(
        candidate =>
          candidate.document.uri.toString() === document.uri.toString()
      );
      return getRecordingCommentingRanges(document, editor?.selection);
    }
  };
}

export function refreshCommentingRanges() {
  updateCommentingRangeProvider();
}

export async function startPlayer() {
  if (controller) {
    controller.dispose();
    if (store.activeTour) {
      store.activeTour.thread = null;
    }
  }

  controller = comments.createCommentController(
    CONTROLLER_ID,
    CONTROLLER_LABEL
  );

  updateCommentingRangeProvider();
}

export async function stopPlayer() {
  if (controller) {
    controller.dispose();
    controller = null;
  } else if (store.activeTour?.thread) {
    store.activeTour.thread.dispose();
  }
  if (store.activeTour) {
    store.activeTour.thread = null;
  }
}

const VIEW_COMMANDS = new Map([
  ["comments", "workbench.panel.comments"],
  ["console", "workbench.panel.console"],
  ["debug", "workbench.view.debug"],
  ["debug:breakpoints", "workbench.debug.action.focusBreakpointsView"],
  ["debug:callstack", "workbench.debug.action.focusCallStackView"],
  ["debug:variables", "workbench.debug.action.focusVariablesView"],
  ["debug:watch", "workbench.debug.action.focusWatchView"],
  ["explorer", "workbench.view.explorer"],
  ["extensions", "workbench.view.extensions"],
  ["extensions:disabled", "extensions.disabledExtensionList.focus"],
  ["extensions:enabled", "extensions.enabledExtensionList.focus"],
  ["output", "workbench.panel.output"],
  ["problems", "workbench.panel.markers"],
  ["scm", "workbench.view.scm"],
  ["search", "workbench.view.search"],
  ["terminal", "terminal.focus"]
]);

function getPreviousTour(): CodeTour | undefined {
  const previousTour = store.tours.find(
    tour => tour.nextTour === store.activeTour?.tour.title
  );

  if (previousTour) {
    return previousTour;
  }

  const match = store.activeTour?.tour.title.match(/^#?(\d+)\s+-/);
  if (match) {
    const previousTourNumber = Number(match[1]) - 1;
    return store.tours.find(tour =>
      tour.title.match(new RegExp(`^#?${previousTourNumber}\\s+[-:]`))
    );
  }
}

function getNextTour(): CodeTour | undefined {
  if (store.activeTour?.tour.nextTour) {
    return store.tours.find(
      tour => tour.title === store.activeTour?.tour.nextTour
    );
  } else {
    const tourNumber = getActiveTourNumber();
    if (tourNumber) {
      const nextTourNumber = tourNumber + 1;
      return store.tours.find(tour =>
        tour.title.match(new RegExp(`^#?${nextTourNumber}\\s+[-:]`))
      );
    }
  }
}

async function renderCurrentStep() {
  const generation = ++renderGeneration;
  const currentTour = store.activeTour!.tour;
  const currentStep = store.activeTour!.step;

  const step = currentTour!.steps[currentStep];
  if (!step) {
    return;
  }

  if (step.file && !step.anchor) {
    store.activeTour!.thread?.dispose();
    store.activeTour!.thread = null;
    void window.showWarningMessage(
      l10n.t(
        "This CodeTour file step has no anchor. Edit the tour and bind the step before playing it."
      )
    );
    return;
  }

  const workspaceRoot = store.activeTour?.workspaceRoot;
  const cachedAnchorResolution = step.anchor
    ? anchorResolver.get(currentTour, currentStep)
    : undefined;
  if (cachedAnchorResolution?.state === "pending") {
    return;
  }
  const anchorResolution = step.anchor
    ? cachedAnchorResolution ||
      (await anchorResolver.resolveStep(currentTour, currentStep))
    : undefined;
  if (
    generation !== renderGeneration ||
    !store.activeTour ||
    store.activeTour.tour.id !== currentTour.id ||
    store.activeTour.step !== currentStep
  ) {
    return;
  }

  if (step.anchor && anchorResolution?.state !== "resolved") {
    store.activeTour.thread?.dispose();
    store.activeTour.thread = null;
    const noticeKey = `${currentTour.id}#${currentStep}#${anchorResolution?.state}`;
    if (lastUnresolvedNotice !== noticeKey) {
      lastUnresolvedNotice = noticeKey;
      const rebind = l10n.t("Rebind");
      const skip = l10n.t("Skip Step");
      void window
        .showWarningMessage(
          step.anchor.type === "symbol"
            ? l10n.t("The symbol for this CodeTour step could not be resolved.")
            : step.anchor.type === "content"
            ? l10n.t("The content for this CodeTour step could not be found.")
            : l10n.t(
                "The line for this CodeTour step is outside the document."
              ),
          rebind,
          skip
        )
        .then(response => {
          if (response === rebind) {
            void commands.executeCommand("codetour.rebindTourStepAnchor", {
              tour: currentTour,
              stepNumber: currentStep
            });
          } else if (response === skip) {
            void commands.executeCommand("codetour.skipUnresolvedTourStep");
          }
        });
    }
    return;
  }
  lastUnresolvedNotice = undefined;

  const uri =
    anchorResolution?.uri ||
    (await getStepFileUri(
      step,
      workspaceRoot,
      currentTour.ref,
      currentTour,
      currentStep
    ));

  let line = anchorResolution?.range?.start.line;

  if (line === undefined) {
    try {
      const document = await workspace.openTextDocument(uri);
      line = Math.max(document.lineCount - 1, 0);
    } catch {
      line = 0;
    }
  }

  if (!anchorResolution?.range) {
    try {
      const document = await workspace.openTextDocument(uri);
      line = Math.min(Math.max(line, 0), Math.max(document.lineCount - 1, 0));
    } catch {
      line = Math.max(line, 0);
    }
  }

  if (
    generation !== renderGeneration ||
    !store.activeTour ||
    store.activeTour.tour.id !== currentTour.id ||
    store.activeTour.step !== currentStep
  ) {
    return;
  }

  const range = anchorResolution?.range || new Range(line!, 0, line!, 0);
  let label = l10n.t(
    "Step #{0} of {1}",
    currentStep + 1,
    currentTour!.steps.length
  );

  if (currentTour.title) {
    const title = getTourTitle(currentTour);
    label += ` (${title})`;
  }

  store.activeTour!.thread?.dispose();
  store.activeTour!.thread = controller!.createCommentThread(uri, range, []);

  const mode =
    store.isRecording && store.isEditing
      ? CommentMode.Editing
      : CommentMode.Preview;
  let content = step.description;

  let hasPreviousStep = currentStep > 0;
  const hasNextStep = currentStep < currentTour.steps.length - 1;
  const isFinalStep = currentStep === currentTour.steps.length - 1;

  const showNavigation = hasPreviousStep || hasNextStep || isFinalStep;
  if (!store.isEditing && showNavigation) {
    content += "\n\n---\n";

    if (hasPreviousStep) {
      const stepLabel = getStepLabel(
        currentTour,
        currentStep - 1,
        false,
        false
      );
      const suffix = stepLabel ? ` (${stepLabel})` : "";
      content += `← [${l10n.t(
        "Previous"
      )}${suffix}](command:codetour.previousTourStep "${l10n.t(
        "Navigate to previous step"
      )}")`;
    } else {
      const previousTour = getPreviousTour();
      if (previousTour) {
        hasPreviousStep = true;

        const tourTitle = getTourTitle(previousTour);
        const argsContent = encodeURIComponent(
          JSON.stringify([previousTour.title])
        );
        content += `← [${l10n.t(
          "Previous Tour"
        )} (${tourTitle})](command:codetour.startTourByTitle?${argsContent} "${l10n.t(
          "Navigate to previous tour"
        )}")`;
      }
    }

    const prefix = hasPreviousStep ? " | " : "";
    if (hasNextStep) {
      const stepLabel = getStepLabel(
        currentTour,
        currentStep + 1,
        false,
        false
      );
      const suffix = stepLabel ? ` (${stepLabel})` : "";
      content += `${prefix}[${l10n.t(
        "Next"
      )}${suffix}](command:codetour.nextTourStep "${l10n.t(
        "Navigate to next step"
      )}") →`;
    } else if (isFinalStep) {
      const nextTour = getNextTour();
      if (nextTour) {
        const tourTitle = getTourTitle(nextTour);
        const argsContent = encodeURIComponent(
          JSON.stringify([nextTour.title])
        );
        content += `${prefix}[${l10n.t(
          "Next Tour"
        )} (${tourTitle})](command:codetour.finishTour?${argsContent} "${l10n.t(
          "Start next tour"
        )}")`;
      } else {
        content += `${prefix}[${l10n.t(
          "Finish Tour"
        )}](command:codetour.finishTour "${l10n.t("Finish the tour")}")`;
      }
    }
  }

  const comment = new CodeTourComment(
    content,
    label,
    store.activeTour!.thread!,
    mode
  );

  // @ts-ignore
  store.activeTour!.thread.canReply = false;
  store.activeTour!.thread.comments = [comment];

  const contextValues = [];
  if (hasPreviousStep) {
    contextValues.push("hasPrevious");
  }

  if (hasNextStep) {
    contextValues.push("hasNext");
  }
  if (step.anchor?.type === "line") {
    contextValues.push("lineAnchor");
  } else if (step.anchor) {
    contextValues.push("resilientAnchor");
  }

  store.activeTour!.thread.contextValue = contextValues.join(".");
  store.activeTour!.thread.collapsibleState =
    CommentThreadCollapsibleState.Expanded;

  const selection =
    anchorResolution?.selection || new Selection(range.start, range.end);

  await showDocument(uri, range, selection);

  if (step.directory) {
    const directoryUri = getFileUri(step.directory, workspaceRoot);
    commands.executeCommand("revealInExplorer", directoryUri);
  } else if (step.view) {
    const commandName = VIEW_COMMANDS.has(step.view)
      ? VIEW_COMMANDS.get(step.view)!
      : `${step.view}.focus`;

    try {
      await commands.executeCommand(commandName);
    } catch {
      window.showErrorMessage(
        l10n.t(
          "The view for this tour step is unavailable: {0}. Check the tour and try again.",
          step.view
        )
      );
    }
  }

  if (step.commands) {
    for (const command of step.commands) {
      let name = command,
        args: any[] = [];

      try {
        if (command.includes("?")) {
          const parts = command.split("?");
          name = parts[0];
          args = JSON.parse(parts.slice(1).join("?"));
          if (!Array.isArray(args)) {
            throw new Error("CodeTour command arguments must be a JSON array.");
          }
        }
        console.log("Executing command", name, JSON.stringify(args));
        await commands.executeCommand(name, ...args);
      } catch (e) {
        window.showErrorMessage(l10n.t("An error occurred: {0}", String(e)));
      }
    }
  }
}

async function showDocument(uri: Uri, range: Range, selection?: Selection) {
  const document =
    window.visibleTextEditors.find(
      editor => editor.document.uri.toString() === uri.toString()
    ) || (await window.showTextDocument(uri, { preserveFocus: true }));

  // TODO: Figure out how to force focus when navigating
  // to documents which are already open.

  if (selection) {
    document.selection = selection;
  }

  document.revealRange(range, TextEditorRevealType.InCenter);
}

export function registerPlayerModule(context: ExtensionContext) {
  registerPlayerCommands();
  registerTreeProvider(context);
  registerFileSystemProvider(context);
  registerTextDocumentContentProvider(context);
  registerStatusBar(context);
  registerDecorators(context);
  void registerCodeStatusModule(context);

  initializeStorage(context);

  context.subscriptions.push(
    window.onDidChangeTextEditorSelection(() => {
      if (store.isRecording) {
        updateCommentingRangeProvider();
      }
    }),
    anchorResolver.onDidChange(() => {
      if (!store.activeTour || store.activeTour.step < 0) {
        return;
      }
      const resolution = anchorResolver.get(
        store.activeTour.tour,
        store.activeTour.step
      );
      if (resolution && resolution.state !== "pending") {
        void renderCurrentStep();
      }
    }),
    commands.registerCommand("codetour.skipUnresolvedTourStep", async () => {
      if (!store.activeTour) {
        return;
      }
      if (store.activeTour.step < store.activeTour.tour.steps.length - 1) {
        store.activeTour.step++;
      } else {
        await commands.executeCommand("codetour.endTour");
      }
    })
  );

  // Watch for changes to the active tour property,
  // and automatically re-render the current step in response.
  const disposeRenderReaction = reaction(
    () => [
      store.activeTour
        ? [
            store.activeTour.step,
            store.activeTour.tour.title,
            store.activeTour.tour.steps.map(step => [
              step.title,
              step.description,
              step.anchor,
              step.directory,
              step.view
            ])
          ]
        : null
    ],
    () => {
      if (store.activeTour) {
        void renderCurrentStep();
      }
    }
  );
  context.subscriptions.push({ dispose: disposeRenderReaction });
}
