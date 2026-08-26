// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as path from "path";
import {
  Disposable,
  Event,
  EventEmitter,
  FileChangeEvent,
  FileChangeType,
  FileStat,
  FileSystemError,
  FileSystemProvider,
  FileType,
  ExtensionContext,
  Uri,
  workspace
} from "vscode";
import { FS_SCHEME } from "../../constants";
import { CodeTour, CodeTourStep, store } from "../../store";
import { saveTour } from "../../store/persistence";

export class CodeTourFileSystemProvider implements FileSystemProvider {
  private count = 0;

  getTourStep(uri: Uri): [CodeTour, CodeTourStep] {
    const params = new URLSearchParams(uri.query);
    const tourId = params.get("tour");
    const stepNumber = Number(params.get("step"));
    const tours = [
      ...(store.activeTour ? [store.activeTour.tour] : []),
      ...(store.activeTour?.tours || []),
      ...store.tours
    ];
    const tour = tours.find(candidate => candidate.id === tourId);
    if (
      !tour ||
      !Number.isInteger(stepNumber) ||
      stepNumber < 0 ||
      stepNumber >= tour.steps.length
    ) {
      throw FileSystemError.FileNotFound(uri);
    }
    const step = tour.steps[stepNumber];
    if (step.contents === undefined) {
      throw FileSystemError.FileNotFound(uri);
    }
    return [tour, step];
  }

  async updateTour(tour: CodeTour, changedUri: Uri): Promise<void> {
    await saveTour(tour);
    this._onDidChangeFile.fire([
      {
        type: FileChangeType.Changed,
        uri: changedUri
      }
    ]);
  }

  async readFile(uri: Uri): Promise<Uint8Array> {
    const [, { contents }] = this.getTourStep(uri);
    return new TextEncoder().encode(contents);
  }

  async writeFile(
    uri: Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const [tour, step] = this.getTourStep(uri);
    step.contents = new TextDecoder().decode(content);
    await this.updateTour(tour, uri);
  }

  async stat(uri: Uri): Promise<FileStat> {
    const [, step] = this.getTourStep(uri);
    return {
      type: FileType.File,
      ctime: 0,
      mtime: ++this.count,
      size: new TextEncoder().encode(step.contents).length
    };
  }

  async rename(
    oldUri: Uri,
    newUri: Uri,
    options: { overwrite: boolean }
  ): Promise<void> {
    const [tour, step] = this.getTourStep(oldUri);
    step.file = path.basename(newUri.path);
    await this.updateTour(tour, newUri);
  }

  // Unimplemented members

  private _onDidChangeFile = new EventEmitter<FileChangeEvent[]>();
  public readonly onDidChangeFile: Event<FileChangeEvent[]> =
    this._onDidChangeFile.event;

  async copy?(
    source: Uri,
    destination: Uri,
    options: { overwrite: boolean }
  ): Promise<void> {
    throw FileSystemError.NoPermissions(
      "CodeTour doesn't support copying files."
    );
  }

  createDirectory(uri: Uri): void {
    throw FileSystemError.NoPermissions(
      "CodeTour doesn't support directories."
    );
  }

  async delete(uri: Uri, options: { recursive: boolean }): Promise<void> {
    throw FileSystemError.NoPermissions(
      "CodeTour doesn't support deleting files."
    );
  }

  async readDirectory(uri: Uri): Promise<[string, FileType][]> {
    throw FileSystemError.NoPermissions("CodeTour doesnt support directories.");
  }

  watch(
    uri: Uri,
    options: { recursive: boolean; excludes: string[] }
  ): Disposable {
    return new Disposable(() => undefined);
  }
}

export function registerFileSystemProvider(context: ExtensionContext) {
  context.subscriptions.push(
    workspace.registerFileSystemProvider(
      FS_SCHEME,
      new CodeTourFileSystemProvider()
    )
  );
}
