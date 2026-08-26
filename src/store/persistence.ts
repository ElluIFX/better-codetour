// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { applyEdits, modify } from "jsonc-parser";
import * as path from "path";
import * as vscode from "vscode";
import { CodeTour } from ".";
import { normalizeSymbolKind } from "../symbolKind";
import { readUriContents } from "../utils";
import { isWritableTourUri } from "./editability";

const LOCAL_SCHEMA = "./schema.json";
const SCHEMA_FILE = "schema.json";

let extensionUri: vscode.Uri | undefined;
const writeQueues = new Map<string, Promise<void>>();
const didSaveTourEmitter = new vscode.EventEmitter<vscode.Uri>();

export const onDidSaveTour = didSaveTourEmitter.event;

export function initializeTourPersistence(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
  context.subscriptions.push(didSaveTourEmitter);
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

export function getTourSchemaReference(tourUri: vscode.Uri): string {
  return LOCAL_SCHEMA;
}

async function ensureSchema(targetUri: vscode.Uri): Promise<void> {
  if (!extensionUri) {
    return;
  }

  const sourceUri = vscode.Uri.joinPath(extensionUri, SCHEMA_FILE);
  const source = await vscode.workspace.fs.readFile(sourceUri);

  try {
    const current = await vscode.workspace.fs.readFile(targetUri);
    if (
      current.length === source.length &&
      current.every((value, index) => value === source[index])
    ) {
      return;
    }
    throw new Error(
      vscode.l10n.t(
        "A different schema.json already exists beside this CodeTour. Choose another directory or resolve the schema conflict."
      )
    );
  } catch {
    try {
      await vscode.workspace.fs.stat(targetUri);
      throw new Error(
        vscode.l10n.t(
          "A different schema.json already exists beside this CodeTour. Choose another directory or resolve the schema conflict."
        )
      );
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError)) {
        throw error;
      }
    }
    await vscode.workspace.fs.createDirectory(
      targetUri.with({ path: path.posix.dirname(targetUri.path) })
    );
  }

  await enqueueWrite(targetUri, () =>
    vscode.workspace.fs.writeFile(targetUri, source)
  );
}

export function ensureTourSchema(tourUri: vscode.Uri): Promise<void> {
  const targetUri = tourUri.with({
    path: path.posix.join(path.posix.dirname(tourUri.path), SCHEMA_FILE)
  });
  return ensureSchema(targetUri);
}

export async function migrateTourSchema(tourUri: vscode.Uri): Promise<boolean> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(tourUri);
  if (
    !workspaceFolder ||
    tourUri.scheme !== workspaceFolder.uri.scheme ||
    !isWritableTourUri(tourUri)
  ) {
    return false;
  }

  await ensureTourSchema(tourUri);
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

export function normalizeTourSymbolKinds(tour: CodeTour): CodeTour {
  return {
    ...tour,
    steps: tour.steps.map(step => {
      if (step.anchor?.type !== "symbol") {
        return step;
      }

      return {
        ...step,
        anchor: {
          ...step.anchor,
          path: step.anchor.path.map(segment => ({
            ...segment,
            kind: normalizeSymbolKind(segment.kind) || segment.kind
          }))
        }
      };
    })
  };
}

export async function saveTour(tour: CodeTour): Promise<void> {
  const uri = vscode.Uri.parse(tour.id);
  if (!isWritableTourUri(uri)) {
    throw new Error(vscode.l10n.t("This CodeTour source is read-only."));
  }
  const normalizedTour = normalizeTourSymbolKinds(tour);
  const { $schema: _schema, id: _id, ...tourData } = normalizedTour;
  const persistedTour = {
    $schema: getTourSchemaReference(uri),
    ...tourData
  };

  const bytes = new TextEncoder().encode(
    JSON.stringify(persistedTour, null, 2)
  );
  await ensureTourSchema(uri);
  await enqueueWrite(uri, () => vscode.workspace.fs.writeFile(uri, bytes));
  didSaveTourEmitter.fire(uri);
}
