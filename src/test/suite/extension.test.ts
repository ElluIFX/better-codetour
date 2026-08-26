// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from "assert";
import * as vscode from "vscode";
import { anchorResolver } from "../../anchors";
import { CodeTour, store } from "../../store";
import {
  getTourSchemaReference,
  initializeTourPersistence,
  migrateTourSchema
} from "../../store/persistence";

function getWorkspaceRoot() {
  return vscode.workspace.workspaceFolders![0].uri;
}

function createTour(step: CodeTour["steps"][number]): CodeTour {
  const tourUri = vscode.Uri.joinPath(
    getWorkspaceRoot(),
    ".tours",
    "test.tour"
  );
  return {
    id: tourUri.toString(),
    title: "Test Tour",
    steps: [step]
  };
}

describe("resilient tour anchors", () => {
  let symbolProvider: vscode.Disposable;
  const resolverDisposables: vscode.Disposable[] = [];

  before(async () => {
    const extension = vscode.extensions.getExtension("vsls-contrib.codetour");
    assert.ok(extension);
    await extension.activate();
    initializeTourPersistence({
      extensionUri: extension.extensionUri
    } as vscode.ExtensionContext);
    anchorResolver.register({
      subscriptions: resolverDisposables
    } as vscode.ExtensionContext);

    symbolProvider = vscode.languages.registerDocumentSymbolProvider(
      { language: "plaintext", scheme: "file" },
      {
        provideDocumentSymbols(document) {
          const outer = new vscode.DocumentSymbol(
            "alphaBlock",
            "",
            vscode.SymbolKind.Class,
            new vscode.Range(0, 0, 1, 4),
            new vscode.Range(0, 0, 0, 5)
          );
          const inner = new vscode.DocumentSymbol(
            "betaMember",
            "",
            vscode.SymbolKind.Method,
            new vscode.Range(1, 0, 1, 4),
            new vscode.Range(1, 0, 1, 4)
          );
          return [outer, inner];
        }
      }
    );
  });

  after(() => {
    symbolProvider.dispose();
    resolverDisposables.reverse().forEach(disposable => disposable.dispose());
  });

  it("resolves the first exact multiline content match", async () => {
    const tour = createTour({
      file: "sample.txt",
      description: "content",
      anchor: { type: "content", text: "alpha\nbeta" }
    });
    const resolution = await anchorResolver.resolveStep(tour, 0);
    assert.strictEqual(resolution?.state, "resolved");
    assert.strictEqual(resolution?.range?.start.line, 0);
    assert.strictEqual(resolution?.range?.end.line, 1);
  });

  it("reports missing content without a line fallback", async () => {
    const tour = createTour({
      file: "sample.txt",
      description: "missing",
      anchor: { type: "content", text: "missing text" }
    });
    const resolution = await anchorResolver.resolveStep(tour, 0);
    assert.strictEqual(resolution?.state, "unresolved");
    assert.strictEqual(resolution?.range, undefined);
  });

  it("resolves a document symbol by strict name and kind", async () => {
    const tour = createTour({
      file: "sample.txt",
      description: "symbol",
      anchor: {
        type: "symbol",
        path: [{ name: "betaMember", kind: vscode.SymbolKind.Method }]
      }
    });
    const resolution = await anchorResolver.resolveStep(tour, 0);
    assert.strictEqual(resolution?.state, "resolved");
    assert.strictEqual(resolution?.range?.start.line, 1);
  });

  it("updates a content anchor after a monitored in-range edit", async () => {
    const tour = createTour({
      file: "sample.txt",
      description: "tracked content",
      anchor: { type: "content", text: "alpha" }
    });
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(getWorkspaceRoot(), ".tours")
    );
    await vscode.workspace.fs.writeFile(
      vscode.Uri.parse(tour.id),
      new TextEncoder().encode(
        JSON.stringify({ title: tour.title, steps: tour.steps }, null, 2)
      )
    );
    store.tours = [tour];
    const resolution = await anchorResolver.resolveStep(tour, 0);
    assert.strictEqual(resolution?.state, "resolved");

    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(getWorkspaceRoot(), "sample.txt")
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(0, 0, 0, 5), "omega");
    assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
    await new Promise(resolve => setTimeout(resolve, 900));

    const anchor = store.tours[0].steps[0].anchor;
    assert.strictEqual(anchor?.type, "content");
    assert.strictEqual(anchor?.type === "content" && anchor.text, "omega");
    store.tours = [];
  });

  it("writes a workspace-local schema and changes only the schema field", async () => {
    const tourUri = vscode.Uri.joinPath(
      getWorkspaceRoot(),
      ".tours",
      "migration.tour"
    );
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(getWorkspaceRoot(), ".tours")
    );
    const original = {
      $schema: "https://aka.ms/codetour-schema",
      title: "Migration",
      steps: [{ description: "legacy", file: "sample.txt", line: 2 }]
    };
    await vscode.workspace.fs.writeFile(
      tourUri,
      new TextEncoder().encode(JSON.stringify(original, null, 4))
    );

    assert.strictEqual(await migrateTourSchema(tourUri), true);
    const migrated = JSON.parse(
      new TextDecoder().decode(await vscode.workspace.fs.readFile(tourUri))
    );
    assert.strictEqual(migrated.$schema, "./schema.json");
    assert.deepStrictEqual(migrated.steps, original.steps);
    assert.strictEqual(getTourSchemaReference(tourUri), "./schema.json");
    await vscode.workspace.fs.stat(
      vscode.Uri.joinPath(getWorkspaceRoot(), ".tours", "schema.json")
    );
  });
});
