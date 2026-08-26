// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { comparer, reaction } from "mobx";
import * as os from "os";
import * as vscode from "vscode";
import {
  CodeTour,
  CodeTourAnchorState,
  CodeTourSymbolPathSegment,
  store
} from "../store";
import { saveTour } from "../store/persistence";
import { isWritableTourSource } from "../store/editability";
import { getFileUri, getStepFileUri, getWorkspaceUri } from "../utils";
import { normalizeSymbolKind, symbolKindsEqual } from "../symbolKind";

interface SymbolCandidate {
  path: CodeTourSymbolPathSegment[];
  range: vscode.Range;
  selectionRange: vscode.Range;
}

interface PendingAnchorUpdate {
  tour: CodeTour;
  step: CodeTour["steps"][number];
  originalStep: string;
  originalAnchor: NonNullable<CodeTour["steps"][number]["anchor"]>;
  uri: vscode.Uri;
}

const IS_WINDOWS = os.platform() === "win32";

export interface AnchorResolution {
  state: CodeTourAnchorState;
  uri: vscode.Uri;
  range?: vscode.Range;
  selection?: vscode.Selection;
  documentVersion?: number;
  startOffset?: number;
  endOffset?: number;
}

function getAnchorKey(tour: CodeTour, stepNumber: number) {
  return `${tour.id}#${stepNumber}`;
}

function getKnownTours() {
  const tours = [
    ...(store.activeTour ? [store.activeTour.tour] : []),
    ...(store.activeTour?.tours || []),
    ...store.tours
  ];
  return tours.filter(
    (tour, index) =>
      tours.findIndex(candidate => candidate.id === tour.id) === index
  );
}

function getTourWorkspaceRoot(tour: CodeTour) {
  if (
    store.activeTour &&
    (store.activeTour.tour.id === tour.id ||
      store.activeTour.tours?.some(candidate => candidate.id === tour.id))
  ) {
    return store.activeTour.workspaceRoot || getWorkspaceUri(tour);
  }
  return getWorkspaceUri(tour);
}

function comparableUri(uri: vscode.Uri) {
  const value = uri.toString();
  return IS_WINDOWS && uri.scheme === "file"
    ? value.toLocaleLowerCase()
    : value;
}

function normalizeContent(text: string) {
  return text.replace(/\r\n/g, "\n");
}

function getFirstLineRange(document: vscode.TextDocument, range: vscode.Range) {
  return document.lineAt(range.start.line).range;
}

function pathsEqual(
  left: readonly CodeTourSymbolPathSegment[],
  right: readonly CodeTourSymbolPathSegment[]
) {
  return (
    left.length === right.length &&
    left.every(
      (segment, index) =>
        segment.name === right[index].name &&
        symbolKindsEqual(segment.kind, right[index].kind)
    )
  );
}

function containsPosition(range: vscode.Range, position: vscode.Position) {
  return range.contains(position);
}

function rangeSize(document: vscode.TextDocument, range: vscode.Range) {
  return document.offsetAt(range.end) - document.offsetAt(range.start);
}

function comparableRangeSize(range: vscode.Range) {
  return (
    (range.end.line - range.start.line) * 1_000_000 +
    range.end.character -
    range.start.character
  );
}

function flattenDocumentSymbols(
  symbols: readonly vscode.DocumentSymbol[],
  parentPath: readonly CodeTourSymbolPathSegment[] = []
): SymbolCandidate[] {
  return symbols.flatMap(symbol => {
    const path = [
      ...parentPath,
      {
        name: symbol.name,
        kind: normalizeSymbolKind(symbol.kind) || symbol.kind
      }
    ];
    return [
      {
        path,
        range: symbol.range,
        selectionRange: symbol.selectionRange
      },
      ...flattenDocumentSymbols(symbol.children, path)
    ];
  });
}

function isSymbolInformation(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation
): symbol is vscode.SymbolInformation {
  return "location" in symbol;
}

async function getSymbolCandidates(
  uri: vscode.Uri
): Promise<SymbolCandidate[] | undefined> {
  const symbols = await vscode.commands.executeCommand<
    Array<vscode.DocumentSymbol | vscode.SymbolInformation>
  >("vscode.executeDocumentSymbolProvider", uri);
  if (!symbols) {
    return undefined;
  }

  if (symbols.some(isSymbolInformation)) {
    const information = symbols.filter(isSymbolInformation);
    const getInformationPath = (
      symbol: vscode.SymbolInformation,
      visited: Set<vscode.SymbolInformation> = new Set()
    ): CodeTourSymbolPathSegment[] => {
      if (!symbol.containerName || visited.has(symbol)) {
        return [
          {
            name: symbol.name,
            kind: normalizeSymbolKind(symbol.kind) || symbol.kind
          }
        ];
      }
      visited.add(symbol);
      const parent = information
        .filter(
          candidate =>
            candidate !== symbol &&
            candidate.name === symbol.containerName &&
            candidate.location.range.contains(symbol.location.range)
        )
        .sort(
          (left, right) =>
            comparableRangeSize(left.location.range) -
            comparableRangeSize(right.location.range)
        )[0];
      return [
        ...(parent ? getInformationPath(parent, visited) : []),
        {
          name: symbol.name,
          kind: normalizeSymbolKind(symbol.kind) || symbol.kind
        }
      ];
    };

    const candidates: SymbolCandidate[] = information.map(symbol => ({
      path: getInformationPath(symbol),
      range: symbol.location.range,
      selectionRange: symbol.location.range
    }));
    symbols
      .filter(symbol => !isSymbolInformation(symbol))
      .forEach(symbol =>
        candidates.push(
          ...flattenDocumentSymbols([symbol as vscode.DocumentSymbol])
        )
      );
    return candidates;
  }

  return flattenDocumentSymbols(symbols as vscode.DocumentSymbol[]);
}

function transformOffset(
  offset: number,
  changes: readonly vscode.TextDocumentContentChangeEvent[],
  endBias: boolean
) {
  let accumulatedDelta = 0;
  const sorted = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);
  for (const change of sorted) {
    const changeStart = change.rangeOffset;
    const changeEnd = change.rangeOffset + change.rangeLength;
    if (offset < changeStart) {
      break;
    }
    if (offset > changeEnd) {
      accumulatedDelta += change.text.length - change.rangeLength;
      continue;
    }

    return changeStart + accumulatedDelta + (endBias ? change.text.length : 0);
  }

  return offset + accumulatedDelta;
}

class TourAnchorResolver implements vscode.Disposable {
  private readonly resolutions = new Map<string, AnchorResolution>();
  private readonly generations = new Map<string, number>();
  private readonly sourceWatchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly pendingAnchorUpdates = new Map<
    CodeTour["steps"][number],
    PendingAnchorUpdate
  >();
  private readonly resolveTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly trackedSymbolOffsets = new Map<
    string,
    { start: number; end: number }
  >();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChange = this.changeEmitter.event;

  mergePendingTour(externalTour: CodeTour) {
    Array.from(this.pendingAnchorUpdates.entries()).forEach(
      ([pendingStep, update]) => {
        if (update.tour.id !== externalTour.id || update.tour === externalTour) {
          return;
        }
        const previousIndex = update.tour.steps.indexOf(update.step);
        const matchingSteps = externalTour.steps
          .map((step, index) => ({ step, index }))
          .filter(({ step }) => JSON.stringify(step) === update.originalStep)
          .sort(
            (left, right) =>
              Math.abs(left.index - previousIndex) -
              Math.abs(right.index - previousIndex)
          );
        this.pendingAnchorUpdates.delete(pendingStep);
        const match = matchingSteps[0];
        if (!match || !update.step.anchor) {
          return;
        }
        match.step.anchor = JSON.parse(JSON.stringify(update.step.anchor));
        this.pendingAnchorUpdates.set(match.step, {
          ...update,
          tour: externalTour,
          step: match.step
        });
      }
    );
    return externalTour;
  }

  register(context: vscode.ExtensionContext) {
    const disposeReaction = reaction(
      () =>
        getKnownTours().map(tour => [
          tour.id,
          getTourWorkspaceRoot(tour)?.toString(),
          tour.steps.map(step => [step.file, step.anchor])
        ]),
      () => {
        this.rebuildSourceWatchers();
        void this.resolveAll();
      },
      { equals: comparer.structural }
    );
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(event =>
        this.handleDocumentChange(event)
      ),
      vscode.workspace.onDidSaveTextDocument(document => {
        this.commitPendingAnchorUpdates(document.uri);
        this.scheduleResolveUri(document.uri);
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        this.restorePendingAnchorUpdates(document.uri);
        this.scheduleResolveUri(document.uri);
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("codetour.autoUpdateAnchors")) {
          void this.resolveAll();
        }
      }),
      { dispose: disposeReaction }
    );
    context.subscriptions.push(this);
    this.rebuildSourceWatchers();
    void this.resolveAll();
  }

  get(tour: CodeTour, stepNumber: number) {
    return this.resolutions.get(getAnchorKey(tour, stepNumber));
  }

  async findSymbolAt(
    uri: vscode.Uri,
    position: vscode.Position
  ): Promise<SymbolCandidate | undefined> {
    const document = await vscode.workspace.openTextDocument(uri);
    const candidates = await getSymbolCandidates(uri);
    return candidates
      ?.filter(candidate => containsPosition(candidate.range, position))
      .sort(
        (left, right) =>
          rangeSize(document, left.range) - rangeSize(document, right.range)
      )[0];
  }

  async resolveStep(
    tour: CodeTour,
    stepNumber: number
  ): Promise<AnchorResolution | undefined> {
    const step = tour.steps[stepNumber];
    if (!step?.anchor || !step.file) {
      return undefined;
    }

    const key = getAnchorKey(tour, stepNumber);
    const generation = (this.generations.get(key) || 0) + 1;
    this.generations.set(key, generation);

    const workspaceRoot = getTourWorkspaceRoot(tour);
    const uri = await getStepFileUri(
      step,
      workspaceRoot,
      tour.ref,
      tour,
      stepNumber
    );
    this.publish(key, { state: "pending", uri }, generation);

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      let resolution: AnchorResolution;
      if (step.anchor.type === "line") {
        const line = step.anchor.number - 1;
        if (
          !Number.isInteger(step.anchor.number) ||
          line < 0 ||
          line >= document.lineCount
        ) {
          resolution = { state: "unresolved", uri };
        } else {
          const range = document.lineAt(line).range;
          resolution = {
            state: "resolved",
            uri,
            range,
            selection: new vscode.Selection(range.start, range.end),
            documentVersion: document.version
          };
        }
      } else if (step.anchor.type === "content") {
        const expectedText = step.anchor.text.replace(
          /\n/g,
          document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"
        );
        const startOffset = document.getText().indexOf(expectedText);
        if (!expectedText || startOffset < 0) {
          resolution = { state: "unresolved", uri };
        } else {
          const endOffset = startOffset + expectedText.length;
          const range = new vscode.Range(
            document.positionAt(startOffset),
            document.positionAt(endOffset)
          );
          const displayRange = getFirstLineRange(document, range);
          resolution = {
            state: "resolved",
            uri,
            range: displayRange,
            selection: new vscode.Selection(range.start, range.end),
            documentVersion: document.version,
            startOffset,
            endOffset
          };
        }
      } else {
        const symbolAnchor = step.anchor;
        const candidates = await getSymbolCandidates(uri);
        if (!candidates) {
          resolution = { state: "unsupported", uri };
        } else {
          const matches = candidates.filter(candidate =>
            pathsEqual(candidate.path, symbolAnchor.path)
          );
          if (matches.length === 0) {
            resolution = { state: "unresolved", uri };
          } else if (matches.length > 1) {
            resolution = { state: "ambiguous", uri };
          } else {
            const match = matches[0];
            const displayRange = getFirstLineRange(document, match.range);
            resolution = {
              state: "resolved",
              uri,
              range: displayRange,
              selection: new vscode.Selection(
                displayRange.start,
                displayRange.end
              ),
              documentVersion: document.version,
              startOffset: document.offsetAt(match.range.start),
              endOffset: document.offsetAt(match.range.end)
            };
          }
        }
      }

      this.publish(key, resolution, generation);
      return resolution;
    } catch {
      const resolution: AnchorResolution = { state: "unresolved", uri };
      this.publish(key, resolution, generation);
      return resolution;
    }
  }

  async resolveAll() {
    await Promise.all(
      getKnownTours().flatMap(tour =>
        tour.steps.map((step, stepNumber) =>
          step.anchor ? this.resolveStep(tour, stepNumber) : Promise.resolve()
        )
      )
    );
  }

  private publish(
    key: string,
    resolution: AnchorResolution,
    generation: number
  ) {
    if (this.generations.get(key) !== generation) {
      return;
    }
    this.resolutions.set(key, resolution);
    this.changeEmitter.fire();
  }

  private rebuildSourceWatchers() {
    const required = new Map<
      string,
      { folder: vscode.WorkspaceFolder | string; pattern: string }
    >();
    getKnownTours().forEach(tour => {
      const workspaceRoot = getTourWorkspaceRoot(tour);
      if (!workspaceRoot) {
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(workspaceRoot);
      const base =
        folder ||
        (workspaceRoot.scheme === "file" ? workspaceRoot.fsPath : undefined);
      if (!base) {
        return;
      }
      tour.steps.forEach(step => {
        if (step.anchor && step.file) {
          required.set(`${workspaceRoot.toString()}|${step.file}`, {
            folder: base,
            pattern: step.file
          });
        }
      });
    });

    this.sourceWatchers.forEach((watcher, key) => {
      if (!required.has(key)) {
        watcher.dispose();
        this.sourceWatchers.delete(key);
      }
    });

    required.forEach(({ folder, pattern }, key) => {
      if (this.sourceWatchers.has(key)) {
        return;
      }
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, pattern)
      );
      watcher.onDidCreate(uri => this.scheduleResolveUri(uri));
      watcher.onDidChange(uri => this.scheduleResolveUri(uri));
      watcher.onDidDelete(uri => this.markUriUnresolved(uri));
      this.sourceWatchers.set(key, watcher);
    });
  }

  private getStepsForUri(uri: vscode.Uri) {
    return getKnownTours().flatMap(tour =>
      tour.steps.flatMap((step, stepNumber) => {
        if (!step.anchor || !step.file) {
          return [];
        }
        const workspaceRoot = getTourWorkspaceRoot(tour);
        if (!workspaceRoot) {
          return [];
        }
        const stepUri = getFileUri(step.file, workspaceRoot);
        return comparableUri(stepUri) === comparableUri(uri)
          ? [{ tour, step, stepNumber }]
          : [];
      })
    );
  }

  private scheduleResolveUri(uri: vscode.Uri) {
    const key = uri.toString();
    const previous = this.resolveTimers.get(key);
    if (previous) {
      clearTimeout(previous);
    }
    this.resolveTimers.set(
      key,
      setTimeout(() => {
        this.resolveTimers.delete(key);
        void this.resolveUri(uri);
      }, 350)
    );
  }

  private async resolveUri(uri: vscode.Uri) {
    const steps = this.getStepsForUri(uri);
    for (const { tour, step, stepNumber } of steps) {
      const key = getAnchorKey(tour, stepNumber);
      const trackedOffset = this.trackedSymbolOffsets.get(key);
      let resolution = await this.resolveStep(tour, stepNumber);
      if (
        resolution?.state === "unresolved" &&
        step.anchor?.type === "symbol" &&
        trackedOffset !== undefined &&
        trackedOffset.end > trackedOffset.start
      ) {
        const document = await vscode.workspace.openTextDocument(uri);
        const candidate = await this.findSymbolAt(
          uri,
          document.positionAt(trackedOffset.start)
        );
        const currentPath = step.anchor.path;
        if (
          candidate &&
          candidate.path.length === currentPath.length &&
          symbolKindsEqual(
            candidate.path[candidate.path.length - 1].kind,
            currentPath[currentPath.length - 1].kind
          )
        ) {
          this.trackPendingAnchorUpdate(tour, step, uri);
          step.anchor.path = candidate.path;
          resolution = await this.resolveStep(tour, stepNumber);
        }
      }
      this.trackedSymbolOffsets.delete(key);
    }
  }

  private markUriUnresolved(uri: vscode.Uri) {
    this.getStepsForUri(uri).forEach(({ tour, stepNumber }) => {
      const key = getAnchorKey(tour, stepNumber);
      const resolution = this.resolutions.get(key);
      if (
        resolution &&
        comparableUri(resolution.uri) !== comparableUri(uri)
      ) {
        return;
      }
      const generation = (this.generations.get(key) || 0) + 1;
      this.generations.set(key, generation);
      this.publish(key, { state: "unresolved", uri }, generation);
    });
  }

  private handleDocumentChange(event: vscode.TextDocumentChangeEvent) {
    const referencedSteps = this.getStepsForUri(event.document.uri);
    if (referencedSteps.length === 0) {
      return;
    }

    const autoUpdate = vscode.workspace
      .getConfiguration("codetour")
      .get("autoUpdateAnchors", true);
    referencedSteps.forEach(({ tour, step, stepNumber }) => {
      const key = getAnchorKey(tour, stepNumber);
      const resolution = this.resolutions.get(key);
      if (
        !resolution ||
        comparableUri(resolution.uri) !== comparableUri(event.document.uri) ||
        resolution?.state !== "resolved" ||
        resolution.startOffset === undefined ||
        resolution.endOffset === undefined ||
        (resolution.documentVersion !== undefined &&
          resolution.documentVersion !== event.document.version - 1)
      ) {
        return;
      }

      const intersects = event.contentChanges.some(change => {
        const changeEnd = change.rangeOffset + change.rangeLength;
        return (
          change.rangeOffset <= resolution.endOffset! &&
          changeEnd >= resolution.startOffset!
        );
      });
      const newStart = transformOffset(
        resolution.startOffset,
        event.contentChanges,
        false
      );
      const newEnd = transformOffset(
        resolution.endOffset,
        event.contentChanges,
        true
      );
      const nextRange = new vscode.Range(
        event.document.positionAt(newStart),
        event.document.positionAt(newEnd)
      );
      const displayRange = getFirstLineRange(event.document, nextRange);
      this.resolutions.set(key, {
        ...resolution,
        range: displayRange,
        selection:
          step.anchor?.type === "symbol"
            ? new vscode.Selection(displayRange.start, displayRange.end)
            : new vscode.Selection(nextRange.start, nextRange.end),
        documentVersion: event.document.version,
        startOffset: newStart,
        endOffset: newEnd
      });
      this.changeEmitter.fire();

      if (
        autoUpdate &&
        isWritableTourSource(tour) &&
        intersects &&
        step.anchor?.type === "content"
      ) {
        const text = normalizeContent(event.document.getText(nextRange));
        if (text) {
          this.trackPendingAnchorUpdate(tour, step, event.document.uri);
          step.anchor.text = text;
        }
      } else if (
        autoUpdate &&
        isWritableTourSource(tour) &&
        step.anchor?.type === "symbol"
      ) {
        this.trackedSymbolOffsets.set(key, { start: newStart, end: newEnd });
      }
    });

    this.scheduleResolveUri(event.document.uri);
  }

  private trackPendingAnchorUpdate(
    tour: CodeTour,
    step: CodeTour["steps"][number],
    uri: vscode.Uri
  ) {
    if (!step.anchor || !isWritableTourSource(tour)) {
      return;
    }
    if (!this.pendingAnchorUpdates.has(step)) {
      this.pendingAnchorUpdates.set(step, {
        tour,
        step,
        originalStep: JSON.stringify(step),
        originalAnchor: JSON.parse(JSON.stringify(step.anchor)),
        uri
      });
    }
  }

  private commitPendingAnchorUpdates(uri: vscode.Uri) {
    const updatesByTour = new Map<string, PendingAnchorUpdate[]>();
    this.pendingAnchorUpdates.forEach((update, step) => {
      if (comparableUri(update.uri) !== comparableUri(uri)) {
        return;
      }
      this.pendingAnchorUpdates.delete(step);
      const updates = updatesByTour.get(update.tour.id) || [];
      updates.push(update);
      updatesByTour.set(update.tour.id, updates);
    });
    updatesByTour.forEach((updates, tourId) => {
      void this.commitPendingTourUpdates(tourId, updates);
    });
  }

  private async commitPendingTourUpdates(
    tourId: string,
    updates: PendingAnchorUpdate[]
  ) {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.parse(tourId));
      if (stat.type !== vscode.FileType.File) {
        return;
      }
      const tour = getKnownTours().find(candidate => candidate.id === tourId);
      if (!tour || !isWritableTourSource(tour)) {
        return;
      }
      let didUpdate = false;
      updates.forEach(update => {
        let step = tour.steps.includes(update.step) ? update.step : undefined;
        if (!step) {
          step = tour.steps.find(candidate => {
            const candidateWithOriginalAnchor = {
              ...candidate,
              anchor: update.originalAnchor
            };
            return JSON.stringify(candidateWithOriginalAnchor) === update.originalStep;
          });
        }
        if (step && update.step.anchor) {
          step.anchor = JSON.parse(JSON.stringify(update.step.anchor));
          didUpdate = true;
        }
      });
      if (didUpdate) {
        await saveTour(tour);
      }
    } catch {
      return;
    }
  }

  private restorePendingAnchorUpdates(uri: vscode.Uri) {
    this.pendingAnchorUpdates.forEach((update, step) => {
      if (comparableUri(update.uri) !== comparableUri(uri)) {
        return;
      }
      this.pendingAnchorUpdates.delete(step);
      if (update.tour.steps.includes(update.step)) {
        update.step.anchor = update.originalAnchor;
      }
    });
  }

  dispose() {
    this.disposables.forEach(disposable => disposable.dispose());
    this.sourceWatchers.forEach(watcher => watcher.dispose());
    this.pendingAnchorUpdates.clear();
    this.resolveTimers.forEach(timer => clearTimeout(timer));
    this.changeEmitter.dispose();
  }
}

export const anchorResolver = new TourAnchorResolver();
