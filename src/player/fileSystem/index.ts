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

  getCurrentTourStep(): [CodeTour, CodeTourStep] {
    const tour = store.activeTour!.tour;
    return [tour, tour.steps[store.activeTour!.step]];
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
    const [, { contents }] = this.getCurrentTourStep();
    return new TextEncoder().encode(contents);
  }

  async writeFile(
    uri: Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const [tour, step] = this.getCurrentTourStep();
    step.contents = new TextDecoder().decode(content);
    await this.updateTour(tour, uri);
  }

  async stat(uri: Uri): Promise<FileStat> {
    return {
      type: FileType.File,
      ctime: 0,
      mtime: ++this.count,
      size: 100
    };
  }

  async rename(
    oldUri: Uri,
    newUri: Uri,
    options: { overwrite: boolean }
  ): Promise<void> {
    const [tour, step] = this.getCurrentTourStep();
    step.file = path.basename(newUri.path);
    await this.updateTour(tour, newUri);
  }

  // Unimplemented members

  private _onDidChangeFile = new EventEmitter<FileChangeEvent[]>();
  public readonly onDidChangeFile: Event<FileChangeEvent[]> = this
    ._onDidChangeFile.event;

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
    throw FileSystemError.NoPermissions(
      "CodeTour doesn't support watching files."
    );
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
