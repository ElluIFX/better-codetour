// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { reaction } from "mobx";
import {
  Disposable,
  Event,
  EventEmitter,
  ExtensionContext,
  l10n,
  MarkdownString,
  TreeDataProvider,
  TreeItem,
  window
} from "vscode";
import { EXTENSION_NAME } from "../../constants";
import { anchorResolver } from "../../anchors";
import { generatePreviewContent } from "..";
import { store } from "../../store";
import { CodeTourNode, CodeTourStepNode } from "./nodes";

class CodeTourTreeProvider implements TreeDataProvider<TreeItem>, Disposable {
  private _disposables: Disposable[] = [];

  private _onDidChangeTreeData = new EventEmitter<TreeItem | undefined>();
  public readonly onDidChangeTreeData: Event<TreeItem | undefined> =
    this._onDidChangeTreeData.event;

  constructor(private extensionPath: string) {
    const disposeReaction = reaction(
      () => [
        store.tours.map(tour => [
          tour.id,
          tour.title,
          tour.description,
          tour.isPrimary,
          tour.steps.map(step => [
            step.title,
            step.description,
            step.icon,
            step.file,
            step.anchor
          ])
        ]),
        store.hasTours,
        store.isRecording,
        store.progress.map(([id, completedSteps]) => [
          id,
          completedSteps.map(step => step)
        ]),
        store.activeTour
          ? [
              store.activeTour.tour.title,
              store.activeTour.tour.description,
              store.activeTour.step,
              store.activeTour.canEditTour,
              store.activeTour.tour.steps.map(step => [
                step.title,
                step.description,
                step.anchor
              ])
            ]
          : null
      ],
      () => {
        this._onDidChangeTreeData.fire(undefined);
      }
    );
    this._disposables.push(
      { dispose: disposeReaction },
      anchorResolver.onDidChange(() =>
        this._onDidChangeTreeData.fire(undefined)
      )
    );
  }

  getTreeItem = (node: TreeItem) => node;

  async getChildren(element?: TreeItem): Promise<TreeItem[] | undefined> {
    if (!element) {
      if (!store.hasTours && !store.activeTour) {
        return undefined;
      } else {
        const tours = store.tours.map(
          tour => new CodeTourNode(tour, this.extensionPath)
        );

        if (
          store.activeTour &&
          !store.tours.find(tour => tour.id === store.activeTour?.tour.id)
        ) {
          tours.unshift(
            new CodeTourNode(store.activeTour.tour, this.extensionPath)
          );
        }

        return tours;
      }
    } else if (element instanceof CodeTourNode) {
      if (element.tour.steps.length === 0) {
        let item;

        if (store.isRecording && store.activeTour?.tour.id == element.tour.id) {
          item = new TreeItem(l10n.t("Add tour step..."));
          item.command = {
            command: "codetour.addContentStep",
            title: l10n.t("Add tour step...")
          };
        } else {
          item = new TreeItem(l10n.t("No steps recorded"));
        }

        return [item];
      } else {
        return element.tour.steps.map(
          (_, index) => new CodeTourStepNode(element.tour, index)
        );
      }
    }
  }

  async getParent(element: TreeItem): Promise<TreeItem | null> {
    if (element instanceof CodeTourStepNode) {
      return new CodeTourNode(element.tour, this.extensionPath);
    } else {
      return null;
    }
  }

  // This is called whenever a tree item is hovered over, and we're
  // using it to generate preview tooltips for tour steps on-demand.
  async resolveTreeItem(element: TreeItem): Promise<TreeItem> {
    if (element instanceof CodeTourStepNode) {
      const content = generatePreviewContent(
        element.tour.steps[element.stepNumber].description,
        element.tour
      );

      const tooltip = new MarkdownString(content);
      tooltip.isTrusted = true;

      // @ts-ignore
      element.tooltip = tooltip;
    }

    return element;
  }

  dispose() {
    this._disposables.forEach(disposable => disposable.dispose());
    this._onDidChangeTreeData.dispose();
  }
}

export function registerTreeProvider(context: ExtensionContext) {
  const treeDataProvider = new CodeTourTreeProvider(context.extensionPath);
  const treeView = window.createTreeView(`${EXTENSION_NAME}.tours`, {
    showCollapseAll: true,
    treeDataProvider,
    canSelectMany: true
  });

  let isRevealPending = false;
  const visibilityDisposable = treeView.onDidChangeVisibility(e => {
    if (e.visible && isRevealPending) {
      isRevealPending = false;
      revealCurrentStepNode();
    }
  });

  function revealCurrentStepNode() {
    const activeTour = store.activeTour;
    if (!activeTour || activeTour.step < 0) {
      return;
    }
    setTimeout(() => {
      if (
        store.activeTour?.tour.id === activeTour.tour.id &&
        store.activeTour.step === activeTour.step &&
        activeTour.tour.steps[activeTour.step]
      ) {
        void treeView
          .reveal(new CodeTourStepNode(activeTour.tour, activeTour.step))
          .then(undefined, () => undefined);
      }
    }, 300);
  }

  const disposeRevealReaction = reaction(
    () => [
      store.activeTour
        ? [
            store.activeTour.tour.title,
            store.activeTour.tour.steps.map(step => [step.title]),
            store.activeTour.step
          ]
        : null
    ],
    () => {
      if (store.activeTour && store.activeTour.step >= 0) {
        if (
          !treeView.visible ||
          store.activeTour.tour.steps[store.activeTour.step].view
        ) {
          isRevealPending = true;
          return;
        }

        revealCurrentStepNode();
      } else {
        // TODO: Once VS Code supports it, we want
        // to de-select the step node once the tour ends.
        treeView.message = undefined;
      }
    }
  );
  context.subscriptions.push(treeDataProvider, treeView, visibilityDisposable, {
    dispose: disposeRevealReaction
  });
}
