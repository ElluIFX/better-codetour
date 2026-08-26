// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  commands,
  EventEmitter,
  l10n,
  Memento,
  RelativePattern,
  Uri,
  window,
  workspace
} from "vscode";
import { CodeTour, store } from ".";
import { EXTENSION_NAME, FS_SCHEME, FS_SCHEME_CONTENT } from "../constants";
import { refreshCommentingRanges, startPlayer, stopPlayer } from "../player";
import { commitActiveTourEdit } from "../recorder/editSession";
import {
  getStepFileUri,
  getWorkspaceKey,
  getWorkspaceUri,
  readUriContents
} from "../utils";
import { progress } from "./storage";
import {
  ensureTourSchema,
  getTourSchemaReference,
  normalizeTourSymbolKinds
} from "./persistence";
import { parseCodeTour } from "./validation";
import { isWritableTourSource, isWritableTourUri } from "./editability";

const CAN_EDIT_TOUR_KEY = `${EXTENSION_NAME}:canEditTour`;
const IN_TOUR_KEY = `${EXTENSION_NAME}:inTour`;
const RECORDING_KEY = `${EXTENSION_NAME}:recording`;
const HAS_ACTIVE_THREAD_KEY = `${EXTENSION_NAME}:hasActiveThread`;
export const EDITING_KEY = `${EXTENSION_NAME}:isEditing`;

const _onDidEndTour = new EventEmitter<CodeTour>();
export const onDidEndTour = _onDidEndTour.event;

const _onDidStartTour = new EventEmitter<[CodeTour, number]>();
export const onDidStartTour = _onDidStartTour.event;

export async function startCodeTourByUri(tourUri: Uri, stepNumber?: number) {
  const bytes = await workspace.fs.readFile(tourUri);
  const contents = new TextDecoder().decode(bytes);
  const tour = parseCodeTour(contents, tourUri.toString());

  if (await commitActiveTourEdit()) {
    startCodeTour(
      tour,
      stepNumber,
      undefined,
      false,
      isWritableTourUri(tourUri)
    );
  }
}

export function startCodeTour(
  tour: CodeTour,
  stepNumber?: number,
  workspaceRoot?: Uri,
  startInEditMode: boolean = false,
  canEditTour: boolean = true,
  tours?: CodeTour[],
  fireEvent: boolean = true
) {
  startPlayer();

  if (!workspaceRoot) {
    workspaceRoot = getWorkspaceUri(tour);
  }

  const requestedStep =
    stepNumber !== undefined && Number.isFinite(stepNumber)
      ? Math.trunc(stepNumber)
      : undefined;
  const step = tour.steps.length
    ? requestedStep !== undefined
      ? Math.min(
          Math.max(requestedStep, 0),
          Math.max(tour.steps.length - 1, 0)
        )
      : 0
    : -1;
  store.activeTour = {
    tour,
    step,
    canEditTour,
    workspaceRoot,
    thread: null,
    tours
  };

  commands.executeCommand("setContext", IN_TOUR_KEY, true);
  commands.executeCommand("setContext", CAN_EDIT_TOUR_KEY, canEditTour);
  commands.executeCommand("setContext", HAS_ACTIVE_THREAD_KEY, false);

  store.isRecording = startInEditMode;
  store.isEditing = startInEditMode && step >= 0;
  commands.executeCommand("setContext", RECORDING_KEY, store.isRecording);
  commands.executeCommand("setContext", EDITING_KEY, store.isEditing);

  if (store.isRecording) {
    refreshCommentingRanges();
  } else if (fireEvent) {
    _onDidStartTour.fire([tour, step]);
  }
}

export async function selectTour(
  tours: CodeTour[],
  workspaceRoot?: Uri,
  step: number = 0
): Promise<boolean> {
  const items: any[] = tours.map(tour => ({
    label: tour.title!,
    tour: tour,
    detail: tour.description
  }));

  if (items.length === 1) {
    const tour = items[0].tour as CodeTour;
    if (
      store.activeTour?.tour.id !== tour.id
        ? !(await endCurrentCodeTour())
        : !(await commitActiveTourEdit())
    ) {
      return false;
    }
    startCodeTour(
      tour,
      step,
      workspace.getWorkspaceFolder(Uri.parse(tour.id))?.uri || workspaceRoot,
      false,
      isTourEditable(tour),
      tours
    );
    return true;
  }

  const response = await window.showQuickPick(items, {
    placeHolder: l10n.t("Select the tour to start...")
  });

  if (response) {
    if (
      store.activeTour?.tour.id !== response.tour.id
        ? !(await endCurrentCodeTour())
        : !(await commitActiveTourEdit())
    ) {
      return false;
    }
    startCodeTour(
      response.tour,
      step,
      workspace.getWorkspaceFolder(Uri.parse(response.tour.id))?.uri ||
        workspaceRoot,
      false,
      isTourEditable(response.tour),
      tours
    );
    return true;
  }

  return false;
}

export async function endCurrentCodeTour(fireEvent: boolean = true) {
  if (!store.activeTour) {
    return true;
  }
  if (!(await commitActiveTourEdit())) {
    void window.showWarningMessage(
      l10n.t("Save or cancel the current CodeTour step edit first.")
    );
    return false;
  }
  if (fireEvent) {
    _onDidEndTour.fire(store.activeTour!.tour);
  }

  store.isRecording = false;
  store.isEditing = false;
  commands.executeCommand("setContext", RECORDING_KEY, false);
  commands.executeCommand("setContext", EDITING_KEY, false);

  stopPlayer();

  store.activeTour = null;
  commands.executeCommand("setContext", IN_TOUR_KEY, false);
  commands.executeCommand("setContext", CAN_EDIT_TOUR_KEY, false);
  commands.executeCommand("setContext", HAS_ACTIVE_THREAD_KEY, false);

  window.visibleTextEditors.forEach(editor => {
    if (
      editor.document.uri.scheme === FS_SCHEME ||
      editor.document.uri.scheme === FS_SCHEME_CONTENT
    ) {
      editor.hide();
    }
  });
  return true;
}

export async function moveCurrentCodeTourBackward() {
  if (!store.activeTour || store.activeTour.step <= 0) {
    return;
  }
  if (!(await commitActiveTourEdit())) {
    return;
  }
  --store.activeTour.step;

  _onDidStartTour.fire([store.activeTour.tour, store.activeTour.step]);
}

export async function moveCurrentCodeTourForward() {
  if (
    !store.activeTour ||
    store.activeTour.step >= store.activeTour.tour.steps.length - 1
  ) {
    return;
  }
  if (!(await commitActiveTourEdit())) {
    return;
  }
  await progress.update();

  store.activeTour!.step++;

  _onDidStartTour.fire([store.activeTour!.tour, store.activeTour!.step]);
}

export function setActiveThreadAvailable(available: boolean) {
  void commands.executeCommand("setContext", HAS_ACTIVE_THREAD_KEY, available);
}

export function isTourEditable(tour: CodeTour) {
  return isWritableTourSource(tour);
}

async function isCodeSwingWorkspace(uri: Uri) {
  const files = await workspace.findFiles(
    new RelativePattern(uri, "codeswing.json"),
    undefined,
    1
  );
  return files && files.length > 0;
}

function isLiveShareWorkspace(uri: Uri) {
  return (
    uri.path.endsWith("Visual Studio Live Share.code-workspace") ||
    uri.scheme === "vsls"
  );
}

export async function promptForTour(
  globalState: Memento,
  workspaceRoot: Uri = getWorkspaceKey(),
  tours: CodeTour[] = store.tours
): Promise<boolean> {
  const key = `${EXTENSION_NAME}:${workspaceRoot}`;
  if (
    tours.length > 0 &&
    !globalState.get(key) &&
    !isLiveShareWorkspace(workspaceRoot) &&
    workspace
      .getConfiguration(EXTENSION_NAME)
      .get("promptForWorkspaceTours", true) &&
    !(await isCodeSwingWorkspace(workspaceRoot))
  ) {
    globalState.update(key, true);

    if (
      await window.showInformationMessage(
        l10n.t(
          "This workspace contains guided tours that introduce the codebase."
        ),
        l10n.t("Start CodeTour")
      )
    ) {
      startDefaultTour(workspaceRoot, tours);
    }
  }

  return false;
}

export async function startDefaultTour(
  workspaceRoot: Uri = getWorkspaceKey(),
  tours: CodeTour[] = store.tours,
  step: number = 0
): Promise<boolean> {
  if (tours.length === 0) {
    return false;
  }

  const primaryTour =
    tours.find(tour => tour.isPrimary) ||
    tours.find(tour => tour.title.match(/^#?1\s+-/));

  if (primaryTour) {
    if (
      store.activeTour?.tour.id !== primaryTour.id
        ? !(await endCurrentCodeTour())
        : !(await commitActiveTourEdit())
    ) {
      return false;
    }
    startCodeTour(
      primaryTour,
      step,
      workspace.getWorkspaceFolder(Uri.parse(primaryTour.id))?.uri ||
        workspaceRoot,
      false,
      isTourEditable(primaryTour),
      tours
    );
    return true;
  } else {
    return selectTour(tours, workspaceRoot, step);
  }
}

export async function exportTour(tour: CodeTour, targetUri: Uri) {
  await ensureTourSchema(targetUri);
  const normalizedTour = normalizeTourSymbolKinds(tour);
  const { $schema: _schema, id: _id, ref: _ref, ...tourData } =
    normalizedTour;
  const newTour: Partial<CodeTour> = {
    $schema: getTourSchemaReference(targetUri),
    ...tourData
  };

  if (newTour.steps) {
    newTour.steps = await Promise.all(
      newTour.steps.map(async (step, stepNumber) => {
        if (step.contents !== undefined || step.uri || !step.file) {
          return step;
        }

        const activeTour = store.activeTour;
        const workspaceRoot =
          activeTour &&
          (activeTour.tour.id === tour.id ||
            activeTour.tours?.some(candidate => candidate.id === tour.id))
            ? activeTour.workspaceRoot
            : getWorkspaceUri(tour);
        const stepFileUri = await getStepFileUri(
          step,
          workspaceRoot,
          tour.ref,
          tour,
          stepNumber
        );
        const contents = await readUriContents(stepFileUri);

        return {
          ...step,
          contents
        };
      })
    );
  }

  return JSON.stringify(newTour, null, 2);
}

export async function recordTour(workspaceRoot: Uri) {
  commands.executeCommand(`${EXTENSION_NAME}.recordTour`, workspaceRoot);
}
