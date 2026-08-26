// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  l10n,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  Uri
} from "vscode";
import { anchorResolver } from "../../anchors";
import { CONTENT_URI, EXTENSION_NAME, FS_SCHEME } from "../../constants";
import { CodeTour, store } from "../../store";
import { progress } from "../../store/storage";
import { getFileUri, getStepLabel, getWorkspaceUri } from "../../utils";

function isRecording(tour: CodeTour) {
  return (
    store.isRecording &&
    store.activeTour &&
    store.activeTour.tour.id === tour.id
  );
}

const completeIcon = new ThemeIcon(
  "check",
  // @ts-ignore
  new ThemeColor("terminal.ansiGreen")
);

export class CodeTourNode extends TreeItem {
  constructor(public tour: CodeTour, extensionPath: string) {
    super(
      tour.title!,
      isRecording(tour)
        ? TreeItemCollapsibleState.Expanded
        : TreeItemCollapsibleState.Collapsed
    );

    this.tooltip = tour.description;
    this.description = l10n.t("{0} steps", tour.steps.length);

    const contextValues = ["codetour.tour"];

    if (tour.isPrimary) {
      contextValues.push("primary");
      this.description += l10n.t(" (Primary)");
    }

    if (isRecording(tour)) {
      contextValues.push("recording");
    }

    const isActive = store.activeTour && tour.id === store.activeTour?.tour.id;
    if (isActive) {
      contextValues.push("active");
    }

    this.contextValue = contextValues.join(".");

    this.iconPath = isRecording(tour)
      ? new ThemeIcon("record")
      : isActive
      ? new ThemeIcon("play-circle")
      : progress.isComplete(tour)
      ? completeIcon
      : new ThemeIcon("location");
  }
}

export class CodeTourStepNode extends TreeItem {
  constructor(public tour: CodeTour, public stepNumber: number) {
    super(getStepLabel(tour, stepNumber));

    const step = tour.steps[stepNumber];
    const anchorResolution = anchorResolver.get(tour, stepNumber);
    const anchorUnavailable =
      !!step.anchor &&
      !!anchorResolution &&
      ["unresolved", "unsupported", "ambiguous"].includes(
        anchorResolution.state
      );

    let workspaceRoot, tours;
    if (store.activeTour && store.activeTour.tour.id === tour.id) {
      workspaceRoot = store.activeTour.workspaceRoot;
      tours = store.activeTour.tours;
    }

    this.command = {
      command: anchorUnavailable
        ? `${EXTENSION_NAME}.rebindTourStepAnchor`
        : `${EXTENSION_NAME}.startTour`,
      title: anchorUnavailable
        ? l10n.t("Rebind Tour Step Anchor")
        : l10n.t("Start Tour"),
      arguments: [tour, stepNumber, workspaceRoot, tours]
    };
    if (anchorUnavailable) {
      this.command.arguments = [this];
      this.description =
        step.anchor!.type === "symbol"
          ? l10n.t("Symbol not found")
          : l10n.t("Content not found");
      this.tooltip =
        step.anchor!.type === "symbol"
          ? l10n.t(
              "The stored symbol path could not be resolved. Select this step to rebind it."
            )
          : l10n.t(
              "The stored content could not be found. Select this step to rebind it."
            );
    }

    let resourceUri;
    if (step.uri) {
      resourceUri = Uri.parse(step.uri);
    } else if (step.contents) {
      resourceUri = Uri.parse(`${FS_SCHEME}://current/${step.file}`);
    } else if (step.file || step.directory) {
      const resourceRoot = workspaceRoot
        ? workspaceRoot
        : getWorkspaceUri(tour);

      resourceUri = getFileUri(step.directory || step.file!, resourceRoot);
    } else {
      resourceUri = CONTENT_URI;
    }

    this.resourceUri = resourceUri;

    const isActive =
      store.activeTour &&
      tour.id === store.activeTour?.tour.id &&
      store.activeTour.step === stepNumber;

    if (anchorUnavailable) {
      this.iconPath = new ThemeIcon(
        "warning",
        new ThemeColor("problemsWarningIcon.foreground")
      );
    } else if (isActive) {
      this.iconPath = new ThemeIcon("play-circle");
    } else if (progress.isComplete(tour, stepNumber)) {
      // @ts-ignore
      this.iconPath = completeIcon;
    } else if (step.icon) {
      if (step.icon.startsWith('.')) {
        const resourceRoot = workspaceRoot
          ? workspaceRoot
          : getWorkspaceUri(tour);
          
          this.iconPath = getFileUri(step.icon, resourceRoot);
      } else {
        try {
          const uri = Uri.parse(step.icon, true);
          
          this.iconPath = uri;
        } catch {
          const data = step.icon.split(',');
          if (data.length > 1) {
            this.iconPath = new ThemeIcon(data[0], new ThemeColor(data[1]));
          } else {
            this.iconPath = new ThemeIcon(data[0]);
          }
        }
      }
    } else if (step.directory) {
      this.iconPath = ThemeIcon.Folder;
    } else {
      this.iconPath = ThemeIcon.File;
    }

    const contextValues = ["codetour.tourStep"];
    if (stepNumber > 0) {
      contextValues.push("hasPrevious");
    }

    if (stepNumber < tour.steps.length - 1) {
      contextValues.push("hasNext");
    }
    if (anchorUnavailable) {
      contextValues.push("unresolved");
    }

    this.contextValue = contextValues.join(".");
  }
}
