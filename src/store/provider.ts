// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as jexl from "jexl";
import { comparer, runInAction, set } from "mobx";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CodeTour, store } from ".";
import { EXTENSION_NAME, VSCODE_DIRECTORY } from "../constants";
import { readUriContents, updateMarkerTitles } from "../utils";
import { endCurrentCodeTour } from "./actions";
import { migrateTourSchemas } from "./persistence";

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

function getTourDirectories() {
  const customDirectory = vscode.workspace
    .getConfiguration(EXTENSION_NAME)
    .get<string | null>("customTourDirectory", null);
  return Array.from(
    new Set(
      [
        ...DEFAULT_TOUR_DIRECTORIES,
        customDirectory?.replace(/\\/g, "/").replace(/^\.\//, "")
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
    console.warn(`Unable to evaluate the CodeTour condition for ${tour.id}.`, error);
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

  runInAction(() => {
    store.tours = discovered
      .flat()
      .sort((left, right) => left.title.localeCompare(right.title))
      .filter(canShowTour);

    if (store.activeTour) {
      const activeTour = store.tours.find(
        tour => tour.id === store.activeTour!.tour.id
      );
      if (activeTour) {
        if (!comparer.structural(store.activeTour.tour, activeTour)) {
          set(store.activeTour.tour, activeTour);
        }
      } else {
        void endCurrentCodeTour();
      }
    }
  });

  await vscode.commands.executeCommand(
    "setContext",
    HAS_TOURS_KEY,
    store.hasTours
  );
  await updateMarkerTitles();
  if (isInitialDiscovery) {
    isInitialDiscovery = false;
    await migrateTourSchemas(store.tours);
  }
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
  try {
    const tour = JSON.parse(await readUriContents(tourUri)) as CodeTour;
    if (!tour.title || !Array.isArray(tour.steps)) {
      throw new Error("The tour must contain a title and steps array.");
    }
    tour.id = tourUri.toString();
    return tour;
  } catch (error) {
    if (!(error instanceof vscode.FileSystemError)) {
      console.warn(`Unable to read CodeTour file ${tourUri.toString()}.`, error);
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

function isDiscoveredTourUri(
  folder: vscode.WorkspaceFolder,
  uri: vscode.Uri
) {
  const folderPath = PLATFORM === "win32"
    ? folder.uri.path.toLocaleLowerCase()
    : folder.uri.path;
  const uriPath = PLATFORM === "win32"
    ? uri.path.toLocaleLowerCase()
    : uri.path;
  const relativePath = path.posix.relative(folderPath, uriPath);
  if (!relativePath || relativePath.startsWith("../")) {
    return false;
  }
  const comparablePath = PLATFORM === "win32"
    ? relativePath.toLocaleLowerCase()
    : relativePath;
  const mainFiles = MAIN_TOUR_FILES.map(file =>
    PLATFORM === "win32" ? file.toLocaleLowerCase() : file
  );
  if (mainFiles.includes(comparablePath)) {
    return true;
  }
  return getTourDirectories().some(directory => {
    const comparableDirectory = PLATFORM === "win32"
      ? directory.toLocaleLowerCase()
      : directory;
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
        scheduleDiscovery();
      }
    };
    watcher.onDidCreate(handleChange);
    watcher.onDidChange(handleChange);
    watcher.onDidDelete(handleChange);
    watchers.push(watcher);
  });
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
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(`${EXTENSION_NAME}.customTourDirectory`)) {
        rebuildWatchers();
        scheduleDiscovery();
      }
    })
  );
}
