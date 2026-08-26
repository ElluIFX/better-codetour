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
import { CONTENT_URI, EXTENSION_NAME } from "../../constants";
import { CodeTour, store } from "../../store";
import { isTourEditable } from "../../store/actions";
import { progress } from "../../store/storage";
import {
  getEmbeddedStepUri,
  getFileUri,
  getStepLabel,
  getWorkspaceUri
} from "../../utils";

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
    if (isTourEditable(tour)) {
      contextValues.push("editable");
    }
    const scheme = tour.id ? Uri.parse(tour.id).scheme : "";
    if (scheme !== "http" && scheme !== "https") {
      contextValues.push("fileBacked");
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
    const anchorMissing = !!step.file && !step.anchor;
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
      command: anchorMissing
        ? `${EXTENSION_NAME}.editTourAtStep`
        : anchorUnavailable
        ? `${EXTENSION_NAME}.rebindTourStepAnchor`
        : isRecording(tour)
        ? `${EXTENSION_NAME}.editTourAtStep`
        : `${EXTENSION_NAME}.startTour`,
      title: anchorMissing
        ? l10n.t("Edit Step")
        : anchorUnavailable
        ? l10n.t("Rebind Tour Step Anchor")
        : isRecording(tour)
        ? l10n.t("Edit Step")
        : l10n.t("Start Tour"),
      arguments: [tour, stepNumber, workspaceRoot, tours]
    };
    if (anchorMissing || (isRecording(tour) && !anchorUnavailable)) {
      this.command.arguments = [this];
    }
    if (anchorMissing) {
      this.description = l10n.t("Anchor missing");
      this.tooltip = l10n.t(
        "This file step has no anchor. Edit the step and bind it before playing the tour."
      );
    } else if (anchorUnavailable) {
      this.command.arguments = [this];
      this.description =
        step.anchor!.type === "symbol"
          ? l10n.t("Symbol not found")
          : step.anchor!.type === "content"
          ? l10n.t("Content not found")
          : l10n.t("Line not found");
      this.tooltip =
        step.anchor!.type === "symbol"
          ? l10n.t(
              "The stored symbol path could not be resolved. Select this step to rebind it."
            )
          : step.anchor!.type === "content"
          ? l10n.t(
              "The stored content could not be found. Select this step to rebind it."
            )
          : l10n.t(
              "The stored line number is outside the document. Select this step to rebind it."
            );
    }

    let resourceUri;
    if (step.uri) {
      resourceUri = Uri.parse(step.uri);
    } else if (step.contents !== undefined) {
      resourceUri = getEmbeddedStepUri(tour, stepNumber, step.file);
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

    if (anchorMissing || anchorUnavailable) {
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
      if (step.icon.startsWith(".")) {
        const resourceRoot = workspaceRoot
          ? workspaceRoot
          : getWorkspaceUri(tour);

        this.iconPath = getFileUri(step.icon, resourceRoot);
      } else {
        try {
          const uri = Uri.parse(step.icon, true);

          this.iconPath = uri;
        } catch {
          const data = step.icon.split(",");
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
    if (anchorMissing) {
      contextValues.push("invalid");
    } else if (anchorUnavailable) {
      contextValues.push("unresolved");
    }
    if (step.anchor?.type === "line") {
      contextValues.push("lineAnchor");
    } else if (step.anchor) {
      contextValues.push("resilientAnchor");
    }
    if (isTourEditable(tour)) {
      contextValues.push("editable");
    }
    if (isRecording(tour)) {
      contextValues.push("recording");
    }

    this.contextValue = contextValues.join(".");
  }
}
