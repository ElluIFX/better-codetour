import * as vscode from "vscode";
import { EXTENSION_NAME } from "../constants";
import { CodeTour, CodeTourStep, store } from "../store";
import { saveTour } from "../store/persistence";

interface EditableComment extends vscode.Comment {
  savedBody?: string;
}

interface DraftStep {
  tourId: string;
  step: CodeTourStep;
  previousStep: number;
  previousStepSnapshot?: string;
}

let draftStep: DraftStep | undefined;
let externalEditConflict:
  | { tour: CodeTour; fallbackStep: number }
  | undefined;
let didShowConflictWarning = false;

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

function showConflictWarning() {
  if (didShowConflictWarning) {
    return;
  }
  didShowConflictWarning = true;
  void vscode.window.showWarningMessage(
    vscode.l10n.t(
      "The active CodeTour step changed on disk. Cancel this edit and reopen the step."
    )
  );
}

function getCommentText(comment: vscode.Comment) {
  return comment.body instanceof vscode.MarkdownString
    ? comment.body.value
    : comment.body;
}

function getActiveComment(): EditableComment | undefined {
  return store.activeTour?.thread?.comments[0] as
    | EditableComment
    | undefined;
}

export function hasPendingActiveTourEdit() {
  if (!store.activeTour || !store.isEditing) {
    return false;
  }
  const step = store.activeTour.tour.steps[store.activeTour.step];
  if (
    step &&
    draftStep?.tourId === store.activeTour.tour.id &&
    draftStep.step === step
  ) {
    return true;
  }
  const comment = getActiveComment();
  return !!comment && getCommentText(comment) !== (comment.savedBody || "");
}

export function mergeExternalTourDuringEdit(externalTour: CodeTour) {
  const activeTour = store.activeTour;
  if (!activeTour || activeTour.tour.id !== externalTour.id) {
    return false;
  }
  const currentStep = activeTour.tour.steps[activeTour.step];
  if (
    currentStep &&
    draftStep?.tourId === externalTour.id &&
    draftStep.step === currentStep
  ) {
    const previousIndex = draftStep.previousStepSnapshot
      ? findMatchingStep(
          externalTour,
          draftStep.previousStepSnapshot,
          draftStep.previousStep
        )
      : undefined;
    const insertionIndex =
      previousIndex !== undefined
        ? previousIndex + 1
        : Math.min(
            Math.max(draftStep.previousStep + 1, 0),
            externalTour.steps.length
          );
    externalTour.steps.splice(insertionIndex, 0, currentStep);
    draftStep.previousStep = insertionIndex - 1;
    activeTour.tour = externalTour;
    activeTour.step = insertionIndex;
    externalEditConflict = undefined;
    didShowConflictWarning = false;
    return true;
  }

  if (currentStep) {
    const matchingIndex = findMatchingStep(
      externalTour,
      JSON.stringify(currentStep),
      activeTour.step
    );
    if (matchingIndex !== undefined) {
      activeTour.tour = externalTour;
      activeTour.step = matchingIndex;
      externalEditConflict = undefined;
      didShowConflictWarning = false;
      return true;
    }
  }

  externalEditConflict = {
    tour: externalTour,
    fallbackStep: externalTour.steps.length
      ? Math.min(Math.max(activeTour.step, 0), externalTour.steps.length - 1)
      : -1
  };
  showConflictWarning();
  return false;
}

async function setEditing(editing: boolean) {
  store.isEditing = editing;
  await vscode.commands.executeCommand(
    "setContext",
    `${EXTENSION_NAME}:isEditing`,
    editing
  );
}

export async function beginDraftStep(
  tour: CodeTour,
  step: CodeTourStep,
  previousStep: number
) {
  draftStep = {
    tourId: tour.id,
    step,
    previousStep,
    previousStepSnapshot:
      previousStep >= 0 ? JSON.stringify(tour.steps[previousStep]) : undefined
  };
  externalEditConflict = undefined;
  didShowConflictWarning = false;
  await setEditing(true);
}

export function clearDraftStep() {
  draftStep = undefined;
  externalEditConflict = undefined;
  didShowConflictWarning = false;
}

export async function commitActiveTourEdit(
  requestedComment?: vscode.Comment
): Promise<boolean> {
  if (!store.activeTour || !store.isEditing) {
    return true;
  }

  if (externalEditConflict) {
    showConflictWarning();
    return false;
  }

  const comment = requestedComment || getActiveComment();
  if (!comment || !store.activeTour.thread?.comments.includes(comment)) {
    return false;
  }

  const tour = store.activeTour.tour;
  const step = tour.steps[store.activeTour.step];
  if (!step) {
    return false;
  }

  const content = getCommentText(comment);
  const isCurrentDraft =
    draftStep?.tourId === tour.id && draftStep.step === step;
  if (isCurrentDraft && content.trim().length === 0) {
    const index = tour.steps.indexOf(step);
    if (index >= 0) {
      tour.steps.splice(index, 1);
    }
    store.activeTour.step = tour.steps.length
      ? Math.min(draftStep!.previousStep, tour.steps.length - 1)
      : -1;
    draftStep = undefined;
    store.activeTour.thread?.dispose();
    store.activeTour.thread = null;
    await setEditing(false);
    return true;
  }

  step.description = content;
  const editableComment = comment as EditableComment;
  editableComment.savedBody = content;
  editableComment.mode = vscode.CommentMode.Preview;
  draftStep = undefined;
  externalEditConflict = undefined;
  didShowConflictWarning = false;
  await setEditing(false);
  await saveTour(tour);
  return true;
}

export async function cancelActiveTourEdit(comment?: vscode.Comment) {
  if (!store.activeTour || !store.isEditing) {
    return;
  }

  const activeComment = (comment || getActiveComment()) as
    | EditableComment
    | undefined;
  const conflict = externalEditConflict;
  const tour = store.activeTour.tour;
  const step = tour.steps[store.activeTour.step];
  const isCurrentDraft =
    !!step && draftStep?.tourId === tour.id && draftStep.step === step;

  if (isCurrentDraft) {
    const index = tour.steps.indexOf(step);
    if (index >= 0) {
      tour.steps.splice(index, 1);
    }
    store.activeTour.step = tour.steps.length
      ? Math.min(draftStep!.previousStep, tour.steps.length - 1)
      : -1;
    draftStep = undefined;
  } else if (activeComment) {
    activeComment.body = activeComment.savedBody || "";
    activeComment.mode = vscode.CommentMode.Preview;
  }

  store.activeTour.thread?.dispose();
  store.activeTour.thread = null;
  if (conflict) {
    store.activeTour.tour = conflict.tour;
    store.activeTour.step = conflict.fallbackStep;
    const index = store.tours.findIndex(
      candidate => candidate.id === conflict.tour.id
    );
    if (index >= 0) {
      store.tours[index] = conflict.tour;
    }
  }
  externalEditConflict = undefined;
  didShowConflictWarning = false;
  await setEditing(false);
}
