// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { applyEdits, modify } from "jsonc-parser";
import * as path from "path";
import * as vscode from "vscode";
import { CodeTour } from ".";
import { readUriContents } from "../utils";

const REMOTE_SCHEMA = "https://aka.ms/codetour-schema";
const SCHEMA_DIRECTORY = ".tours";
const SCHEMA_FILE = "schema.json";

let extensionUri: vscode.Uri | undefined;
const writeQueues = new Map<string, Promise<void>>();

export function initializeTourPersistence(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
}

function enqueueWrite(
  uri: vscode.Uri,
  operation: () => PromiseLike<void>
): Promise<void> {
  const key = uri.toString();
  const previous = writeQueues.get(key) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => await operation());
  writeQueues.set(key, current);
  return current.finally(() => {
    if (writeQueues.get(key) === current) {
      writeQueues.delete(key);
    }
  });
}

function getWorkspaceSchemaUri(workspaceFolder: vscode.WorkspaceFolder) {
  return vscode.Uri.joinPath(
    workspaceFolder.uri,
    SCHEMA_DIRECTORY,
    SCHEMA_FILE
  );
}

export function getTourSchemaReference(tourUri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(tourUri);
  if (!workspaceFolder) {
    return REMOTE_SCHEMA;
  }

  const schemaUri = getWorkspaceSchemaUri(workspaceFolder);
  let relative = path.posix.relative(
    path.posix.dirname(tourUri.path),
    schemaUri.path
  );
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }

  return relative;
}

export async function ensureWorkspaceSchema(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<void> {
  if (!extensionUri) {
    return;
  }

  const sourceUri = vscode.Uri.joinPath(extensionUri, SCHEMA_FILE);
  const targetUri = getWorkspaceSchemaUri(workspaceFolder);
  const source = await vscode.workspace.fs.readFile(sourceUri);

  try {
    const current = await vscode.workspace.fs.readFile(targetUri);
    if (
      current.length === source.length &&
      current.every((value, index) => value === source[index])
    ) {
      return;
    }
  } catch {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(workspaceFolder.uri, SCHEMA_DIRECTORY)
    );
  }

  await enqueueWrite(targetUri, () =>
    vscode.workspace.fs.writeFile(targetUri, source)
  );
}

export async function migrateTourSchema(tourUri: vscode.Uri): Promise<boolean> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(tourUri);
  if (!workspaceFolder || tourUri.scheme !== workspaceFolder.uri.scheme) {
    return false;
  }

  await ensureWorkspaceSchema(workspaceFolder);
  const source = await readUriContents(tourUri);
  const schemaReference = getTourSchemaReference(tourUri);
  const edits = modify(source, ["$schema"], schemaReference, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: source.includes("\r\n") ? "\r\n" : "\n"
    }
  });
  const updated = applyEdits(source, edits);
  if (updated === source) {
    return false;
  }

  await enqueueWrite(tourUri, () =>
    vscode.workspace.fs.writeFile(tourUri, new TextEncoder().encode(updated))
  );
  return true;
}

export async function migrateTourSchemas(tours: readonly CodeTour[]) {
  const results = await Promise.allSettled(
    tours.map(tour => migrateTourSchema(vscode.Uri.parse(tour.id)))
  );
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn(
        `Unable to migrate the schema reference for ${tours[index].id}.`,
        result.reason
      );
    }
  });
}

export async function saveTour(tour: CodeTour): Promise<void> {
  const uri = vscode.Uri.parse(tour.id);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (workspaceFolder) {
    await ensureWorkspaceSchema(workspaceFolder);
  }

  const persistedTour = {
    $schema: getTourSchemaReference(uri),
    ...tour,
    steps: tour.steps.map(({ markerTitle: _markerTitle, ...step }) => step)
  } as Partial<CodeTour> & { $schema: string };
  delete persistedTour.id;

  const bytes = new TextEncoder().encode(
    JSON.stringify(persistedTour, null, 2)
  );
  await enqueueWrite(uri, () => vscode.workspace.fs.writeFile(uri, bytes));
}
