// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as jexl from "jexl";
import { runInAction } from "mobx";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CodeTour, store } from ".";
import { anchorResolver } from "../anchors";
import { EXTENSION_NAME, VSCODE_DIRECTORY } from "../constants";
import { readUriContents } from "../utils";
import {
  cancelActiveTourEdit,
  hasPendingActiveTourEdit,
  mergeExternalTourDuringEdit
} from "../recorder/editSession";
import { endCurrentCodeTour } from "./actions";
import { migrateTourSchemas, onDidSaveTour } from "./persistence";
import { parseCodeTour } from "./validation";

export const MAIN_TOUR_FILES = [
  ".tour",
  `${VSCODE_DIRECTORY}/main.tour`,
  "main.tour"
];

const DEFAULT_TOUR_DIRECTORIES = [
  `${VSCODE_DIRECTORY}/tours`,
  ".github/tours",
  ".tours"
];

const HAS_TOURS_KEY = `${EXTENSION_NAME}:hasTours`;
const PLATFORM = os.platform();
const TOUR_CONTEXT = {
  isLinux: PLATFORM === "linux",
  isMac: PLATFORM === "darwin",
  isWindows: PLATFORM === "win32",
  isWeb: vscode.env.uiKind === vscode.UIKind.Web
};

let discoveryGeneration = 0;
let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
let watchers: vscode.FileSystemWatcher[] = [];
let isInitialDiscovery = true;
let manualRefresh: Promise<number> | undefined;
const lastValidTours = new Map<string, CodeTour>();
const deletedTourUris = new Set<string>();

function getTourDirectories() {
  const customDirectory = vscode.workspace
    .getConfiguration(EXTENSION_NAME)
    .get<string | null>("customTourDirectory", null);
  return Array.from(
    new Set(
      [
        ...DEFAULT_TOUR_DIRECTORIES,
        customDirectory
          ?.replace(/\\/g, "/")
          .replace(/^\.\//, "")
          .replace(/\/$/, "")
      ].filter((directory): directory is string => !!directory)
    )
  );
}

function canShowTour(tour: CodeTour) {
  if (!tour.when) {
    return true;
  }
  try {
    return Boolean(jexl.evalSync(tour.when, TOUR_CONTEXT));
  } catch (error) {
    console.warn(
      `Unable to evaluate the CodeTour condition for ${tour.id}.`,
      error
    );
    return false;
  }
}

export async function discoverTours(): Promise<void> {
  const generation = ++discoveryGeneration;
  const folders = vscode.workspace.workspaceFolders || [];
  const discovered = await Promise.all(
    folders.map(async workspaceFolder => {
      const [mainTours, subTours] = await Promise.all([
        discoverMainTours(workspaceFolder.uri),
        discoverSubTours(workspaceFolder.uri)
      ]);
      return [...mainTours, ...subTours];
    })
  );
  if (generation !== discoveryGeneration) {
    return;
  }

  const nextTours = discovered
    .flat()
    .sort((left, right) => left.title.localeCompare(right.title))
    .filter(canShowTour)
    .map(tour => anchorResolver.mergePendingTour(tour));
  let activeTourWasDeleted = false;

  runInAction(() => {
    store.tours = nextTours;

    if (store.activeTour) {
      const activeTour = store.tours.find(
        tour => tour.id === store.activeTour!.tour.id
      );
      if (activeTour) {
        if (hasPendingActiveTourEdit()) {
          const index = store.tours.indexOf(activeTour);
          mergeExternalTourDuringEdit(activeTour);
          store.tours[index] = store.activeTour.tour;
          return;
        }
        const previousStepNumber = store.activeTour.step;
        const previousStep =
          previousStepNumber >= 0 &&
          previousStepNumber < store.activeTour.tour.steps.length
            ? store.activeTour.tour.steps[previousStepNumber]
            : undefined;
        let nextStepNumber = previousStepNumber;
        if (previousStep) {
          const serializedStep = JSON.stringify(previousStep);
          if (
            !activeTour.steps[previousStepNumber] ||
            JSON.stringify(activeTour.steps[previousStepNumber]) !==
              serializedStep
          ) {
            const matchingStepNumbers = activeTour.steps
              .map((step, index) => ({ step, index }))
              .filter(({ step }) => JSON.stringify(step) === serializedStep)
              .sort(
                (left, right) =>
                  Math.abs(left.index - previousStepNumber) -
                  Math.abs(right.index - previousStepNumber)
              );
            if (matchingStepNumbers.length > 0) {
              nextStepNumber = matchingStepNumbers[0].index;
            }
          }
        }
        nextStepNumber = activeTour.steps.length
          ? Math.min(Math.max(nextStepNumber, 0), activeTour.steps.length - 1)
          : -1;
        store.activeTour.tour = activeTour;
        store.activeTour.step = nextStepNumber;
      } else {
        const activeUri = vscode.Uri.parse(store.activeTour.tour.id);
        const folder = vscode.workspace.getWorkspaceFolder(activeUri);
        if (folder && isDiscoveredTourUri(folder, activeUri)) {
          activeTourWasDeleted = true;
        }
      }
    }
  });

  if (activeTourWasDeleted) {
    await cancelActiveTourEdit();
    await endCurrentCodeTour(false);
  }

  await vscode.commands.executeCommand(
    "setContext",
    HAS_TOURS_KEY,
    store.hasTours
  );
  if (isInitialDiscovery) {
    isInitialDiscovery = false;
    await migrateTourSchemas(store.tours);
  }
}

export function refreshTours(): Promise<number> {
  if (manualRefresh) {
    return manualRefresh;
  }

  manualRefresh = (async () => {
    if (discoveryTimer) {
      clearTimeout(discoveryTimer);
      discoveryTimer = undefined;
    }
    deletedTourUris.clear();
    rebuildWatchers();
    await discoverTours();
    return store.tours.length;
  })().finally(() => {
    manualRefresh = undefined;
  });
  return manualRefresh;
}

function scheduleDiscovery() {
  if (discoveryTimer) {
    clearTimeout(discoveryTimer);
  }
  discoveryTimer = setTimeout(() => {
    discoveryTimer = undefined;
    void discoverTours();
  }, 100);
}

async function discoverMainTours(workspaceUri: vscode.Uri) {
  const tours = await Promise.all(
    MAIN_TOUR_FILES.map(tourFile =>
      readTourFile(vscode.Uri.joinPath(workspaceUri, tourFile))
    )
  );
  return tours.filter((tour): tour is CodeTour => !!tour);
}

async function readTourDirectory(uri: vscode.Uri): Promise<CodeTour[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const tours = await Promise.all(
      entries.map(async ([file, type]): Promise<CodeTour | CodeTour[]> => {
        const fileUri = vscode.Uri.joinPath(uri, file);
        if (type === vscode.FileType.Directory) {
          return readTourDirectory(fileUri);
        }
        if (
          (type === vscode.FileType.File ||
            type === vscode.FileType.SymbolicLink) &&
          file.toLocaleLowerCase().endsWith(".tour")
        ) {
          return (await readTourFile(fileUri)) || [];
        }
        return [];
      })
    );
    return tours.flat().filter((tour): tour is CodeTour => !!tour);
  } catch {
    return [];
  }
}

async function readTourFile(
  tourUri: vscode.Uri
): Promise<CodeTour | undefined> {
  const key = tourUri.toString();
  if (deletedTourUris.has(key)) {
    return undefined;
  }
  try {
    const openDocument = vscode.workspace.textDocuments.find(
      document => document.uri.toString() === key
    );
    const source = openDocument
      ? openDocument.getText()
      : await readUriContents(tourUri);
    const tour = parseCodeTour(source, key);
    lastValidTours.set(key, tour);
    return tour;
  } catch (error) {
    const openDocument = vscode.workspace.textDocuments.find(
      document => document.uri.toString() === key
    );
    if (openDocument?.isDirty) {
      return lastValidTours.get(key);
    }
    if (!(error instanceof vscode.FileSystemError)) {
      console.warn(`Unable to read CodeTour file ${key}.`, error);
    }
    return undefined;
  }
}

async function discoverSubTours(workspaceUri: vscode.Uri) {
  const tours = await Promise.all(
    getTourDirectories().map(directory =>
      readTourDirectory(vscode.Uri.joinPath(workspaceUri, directory))
    )
  );
  return tours.flat();
}

function disposeWatchers() {
  watchers.forEach(watcher => watcher.dispose());
  watchers = [];
}

function isDiscoveredTourUri(folder: vscode.WorkspaceFolder, uri: vscode.Uri) {
  const folderPath =
    PLATFORM === "win32"
      ? folder.uri.path.toLocaleLowerCase()
      : folder.uri.path;
  const uriPath =
    PLATFORM === "win32" ? uri.path.toLocaleLowerCase() : uri.path;
  const relativePath = path.posix.relative(folderPath, uriPath);
  if (!relativePath || relativePath.startsWith("../")) {
    return false;
  }
  const comparablePath =
    PLATFORM === "win32" ? relativePath.toLocaleLowerCase() : relativePath;
  const mainFiles = MAIN_TOUR_FILES.map(file =>
    PLATFORM === "win32" ? file.toLocaleLowerCase() : file
  );
  if (mainFiles.includes(comparablePath)) {
    return true;
  }
  return getTourDirectories().some(directory => {
    const comparableDirectory =
      PLATFORM === "win32" ? directory.toLocaleLowerCase() : directory;
    return comparablePath.startsWith(`${comparableDirectory}/`);
  });
}

function rebuildWatchers() {
  disposeWatchers();
  const folders = vscode.workspace.workspaceFolders || [];
  folders.forEach(folder => {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, "**/*.tour")
    );
    const handleChange = (uri: vscode.Uri) => {
      const isDiscovered = isDiscoveredTourUri(folder, uri);
      if (isDiscovered) {
        deletedTourUris.delete(uri.toString());
        scheduleDiscovery();
      }
    };
    const handleDelete = (uri: vscode.Uri) => {
      if (isDiscoveredTourUri(folder, uri)) {
        const key = uri.toString();
        deletedTourUris.add(key);
        lastValidTours.delete(key);
        scheduleDiscovery();
      }
    };
    watcher.onDidCreate(handleChange);
    watcher.onDidChange(handleChange);
    watcher.onDidDelete(handleDelete);
    watchers.push(watcher);
  });
}

function markTourChanged(uri: vscode.Uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder && isDiscoveredTourUri(folder, uri)) {
    deletedTourUris.delete(uri.toString());
    scheduleDiscovery();
  }
}

function markTourDeleted(uri: vscode.Uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder && isDiscoveredTourUri(folder, uri)) {
    const key = uri.toString();
    deletedTourUris.add(key);
    lastValidTours.delete(key);
    scheduleDiscovery();
  }
}

export function registerTourProvider(context: vscode.ExtensionContext) {
  rebuildWatchers();
  context.subscriptions.push(
    {
      dispose() {
        disposeWatchers();
        if (discoveryTimer) {
          clearTimeout(discoveryTimer);
        }
      }
    },
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      rebuildWatchers();
      scheduleDiscovery();
    }),
    vscode.workspace.onDidCreateFiles(event =>
      event.files.forEach(markTourChanged)
    ),
    vscode.workspace.onDidDeleteFiles(event =>
      event.files.forEach(markTourDeleted)
    ),
    vscode.workspace.onDidRenameFiles(event =>
      event.files.forEach(({ oldUri, newUri }) => {
        markTourDeleted(oldUri);
        markTourChanged(newUri);
      })
    ),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(`${EXTENSION_NAME}.customTourDirectory`)) {
        rebuildWatchers();
        scheduleDiscovery();
      }
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      const folder = vscode.workspace.getWorkspaceFolder(event.document.uri);
      if (folder && isDiscoveredTourUri(folder, event.document.uri)) {
        scheduleDiscovery();
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (folder && isDiscoveredTourUri(folder, document.uri)) {
        scheduleDiscovery();
      }
    }),
    onDidSaveTour(uri => {
      deletedTourUris.delete(uri.toString());
      scheduleDiscovery();
    })
  );
}
