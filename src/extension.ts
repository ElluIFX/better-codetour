// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vscode from "vscode";
import { anchorResolver } from "./anchors";
import { initializeApi } from "./api";
import { initializeGitApi } from "./git";
import { registerLiveShareModule } from "./liveShare";
import { registerNotebookProvider } from "./notebook";
import { registerPlayerModule } from "./player";
import { registerRecorderModule } from "./recorder";
import { store } from "./store";
import {
  promptForTour,
  selectTour,
  startCodeTour,
  startDefaultTour
} from "./store/actions";
import {
  discoverTours as _discoverTours,
  registerTourProvider
} from "./store/provider";
import { initializeTourPersistence } from "./store/persistence";

/**
 * In order to check whether the URI handler was called on activation,
 * we must do this dance around `discoverTours`. The same call to
 * `discoverTours` is shared between `activate` and the URI handler.
 */
let cachedDiscoverTours: Promise<void> | undefined;
function discoverTours(): Promise<void> {
  if (!cachedDiscoverTours) {
    cachedDiscoverTours = _discoverTours().finally(() => {
      cachedDiscoverTours = undefined;
    });
  }
  return cachedDiscoverTours;
}

async function startTour(params: URLSearchParams) {
  let tourPath = params.get("tour");
  const step = params.get("step");

  let stepNumber;
  if (step) {
    // Allow the step number to be
    // provided as 1-based vs. 0-based
    const parsedStep = Number(step);
    if (Number.isFinite(parsedStep) && Number.isInteger(parsedStep)) {
      stepNumber = parsedStep - 1;
    }
  }

  if (tourPath) {
    if (!tourPath.endsWith(".tour")) {
      tourPath = `${tourPath}.tour`;
    }

    const tours = store.tours.filter(tour =>
      tour.id.endsWith(tourPath as string)
    );
    if (tours.length > 0) {
      const ended = await vscode.commands.executeCommand<boolean>(
        "codetour.endTour",
        false
      );
      if (ended === false) {
        return;
      }
      if (tours.length === 1) {
        const tour = tours[0];
        startCodeTour(
          tour,
          stepNumber,
          vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(tour.id))?.uri
        );
      } else {
        await selectTour(tours, undefined, stepNumber);
      }
    }
  } else {
    await startDefaultTour(undefined, undefined, stepNumber);
  }
}

class URIHandler implements vscode.UriHandler {
  private _didStartDefaultTour = false;
  get didStartDefaultTour(): boolean {
    return this._didStartDefaultTour;
  }

  async handleUri(uri: vscode.Uri): Promise<void> {
    this._didStartDefaultTour = true;
    await discoverTours();

    let query = uri.query;
    if (uri.path === "/startDefaultTour") {
      query = vscode.Uri.parse(uri.query).query;
    }

    if (query) {
      const params = new URLSearchParams(query);
      await startTour(params);
    } else {
      startDefaultTour();
    }
  }
}

export async function activate(context: vscode.ExtensionContext) {
  initializeTourPersistence(context);
  registerTourProvider(context);
  registerPlayerModule(context);
  registerRecorderModule(context);
  registerNotebookProvider(context);
  void registerLiveShareModule(context).catch(error =>
    console.warn("Unable to register CodeTour Live Share.", error)
  );
  anchorResolver.register(context);

  const uriHandler = new URIHandler();
  context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

  if (vscode.workspace.workspaceFolders) {
    await discoverTours();

    if (!uriHandler.didStartDefaultTour) {
      promptForTour(context.globalState);
    }

    initializeGitApi();
  }

  return initializeApi(context);
}
