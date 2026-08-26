// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from "assert";
import * as vscode from "vscode";
import { anchorResolver } from "../../anchors";
import { getRecordingCommentingRanges } from "../../player";
import { CodeTourFileSystemProvider } from "../../player/fileSystem";
import { getGutterStepAnchor } from "../../recorder/commands";
import {
  cancelActiveTourEdit,
  mergeExternalTourDuringEdit
} from "../../recorder/editSession";
import { CodeTour, store } from "../../store";
import { isWritableTourUri } from "../../store/editability";
import {
  getTourSchemaReference,
  initializeTourPersistence,
  migrateTourSchema,
  saveTour
} from "../../store/persistence";
import { discoverTours, registerTourProvider } from "../../store/provider";
import { getEmbeddedStepUri } from "../../utils";

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

async function waitFor(
  predicate: () => boolean,
  timeout = 5000
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail("Timed out while waiting for the extension state to update.");
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

describe("resilient tour anchors", () => {
  let symbolProvider: vscode.Disposable;
  let extensionUri: vscode.Uri;
  const resolverDisposables: vscode.Disposable[] = [];

  before(async () => {
    const extension = vscode.extensions.getExtension("ElluIFX.better-codetour");
    assert.ok(extension);
    await extension.activate();
    extensionUri = extension.extensionUri;
    const testContext = {
      extensionUri,
      subscriptions: resolverDisposables
    } as vscode.ExtensionContext;
    initializeTourPersistence(testContext);
    anchorResolver.register(testContext);
    registerTourProvider(testContext);
    await discoverTours();

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

  it("loads the Simplified Chinese runtime bundle", function () {
    if (vscode.env.language !== "zh-cn") {
      this.skip();
    }
    assert.strictEqual(vscode.l10n.t("Start Tour"), "开始 Tour");
  });

  it("keeps the default and Simplified Chinese runtime bundles complete", async () => {
    const readBundle = async (file: string) =>
      JSON.parse(
        new TextDecoder().decode(
          await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(extensionUri, "l10n", file)
          )
        )
      );
    const english = await readBundle("bundle.l10n.json");
    const chinese = await readBundle("bundle.l10n.zh-cn.json");
    assert.deepStrictEqual(
      Object.keys(chinese).sort(),
      Object.keys(english).sort()
    );
    assert.strictEqual(chinese["Start Tour"], "开始 Tour");
  });

  it("defines only the three anchor formats in the bundled schema", async () => {
    const schema = JSON.parse(
      new TextDecoder().decode(
        await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(extensionUri, "schema.json")
        )
      )
    );
    const stepProperties = schema.definitions.step.properties;
    assert.strictEqual(stepProperties.line, undefined);
    assert.strictEqual(stepProperties.selection, undefined);
    assert.strictEqual(stepProperties.pattern, undefined);
    assert.deepStrictEqual(
      schema.definitions.anchor.oneOf.map(
        (item: any) => item.properties.type.const
      ),
      ["line", "symbol", "content"]
    );
    const symbolKind = schema.definitions.symbolPathSegment.properties.kind;
    assert.ok(symbolKind.oneOf[0].enum.includes("Class"));
    assert.ok(symbolKind.oneOf[0].enum.includes("Method"));
    assert.strictEqual(symbolKind.oneOf[1].type, "integer");
    assert.strictEqual(schema.definitions.step.oneOf.length, 5);
  });

  it("partitions selected and line-based gutter commenting ranges", async () => {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(getWorkspaceRoot(), "sample.txt")
    );
    const selection = new vscode.Selection(0, 1, 1, 2);
    const ranges = getRecordingCommentingRanges(document, selection);
    assert.ok(ranges[0].isEqual(selection));
    assert.strictEqual(ranges.length, 2);
    assert.strictEqual(ranges[1].start.line, 2);
    assert.strictEqual(ranges[1].end.line, document.lineCount - 1);
  });

  it("selects content or line anchors for the corresponding gutter plus", async () => {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(getWorkspaceRoot(), "sample.txt")
    );
    const selection = new vscode.Selection(0, 0, 1, 4);
    assert.deepStrictEqual(getGutterStepAnchor(document, selection, 0), {
      type: "content",
      text: "alpha\nbeta"
    });
    assert.deepStrictEqual(getGutterStepAnchor(document, selection, 2), {
      type: "line",
      number: 3
    });
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
    assert.strictEqual(resolution?.range?.end.line, 0);
    assert.strictEqual(resolution?.selection?.end.line, 1);
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

  it("resolves canonical English SymbolKind names", async () => {
    const tour = createTour({
      file: "sample.txt",
      description: "canonical symbol",
      anchor: {
        type: "symbol",
        path: [{ name: "betaMember", kind: "Method" }]
      }
    });
    const resolution = await anchorResolver.resolveStep(tour, 0);
    assert.strictEqual(resolution?.state, "resolved");
    assert.strictEqual(resolution?.range?.start.line, 1);
  });

  it("selects only the first line of a multiline symbol", async () => {
    const tour = createTour({
      file: "sample.txt",
      description: "outer symbol",
      anchor: {
        type: "symbol",
        path: [{ name: "alphaBlock", kind: vscode.SymbolKind.Class }]
      }
    });
    const resolution = await anchorResolver.resolveStep(tour, 0);
    assert.strictEqual(resolution?.state, "resolved");
    assert.strictEqual(resolution?.range?.start.line, 0);
    assert.strictEqual(resolution?.range?.end.line, 0);
    assert.strictEqual(resolution?.selection?.start.line, 0);
    assert.strictEqual(resolution?.selection?.end.line, 0);
  });

  it("resolves a line anchor without legacy fields", async () => {
    const tour = createTour({
      file: "sample.txt",
      description: "line",
      anchor: { type: "line", number: 2 }
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
    const secondEdit = new vscode.WorkspaceEdit();
    secondEdit.replace(document.uri, new vscode.Range(0, 0, 0, 5), "theta");
    assert.strictEqual(await vscode.workspace.applyEdit(secondEdit), true);
    await new Promise(resolve => setTimeout(resolve, 900));

    const anchor = store.tours[0].steps[0].anchor;
    assert.strictEqual(anchor?.type, "content");
    assert.strictEqual(anchor?.type === "content" && anchor.text, "theta");
    const persistedBeforeSave = JSON.parse(
      new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.parse(tour.id))
      )
    );
    assert.strictEqual(persistedBeforeSave.steps[0].anchor.text, "alpha");

    assert.strictEqual(await document.save(), true);
    await new Promise(resolve => setTimeout(resolve, 700));
    const persistedAfterSave = JSON.parse(
      new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.parse(tour.id))
      )
    );
    assert.strictEqual(persistedAfterSave.steps[0].anchor.text, "theta");
    store.tours = [];
  });

  it("does not mutate anchors from a read-only tour source", async () => {
    const fileUri = vscode.Uri.joinPath(getWorkspaceRoot(), "readonly.txt");
    await vscode.workspace.fs.writeFile(
      fileUri,
      new TextEncoder().encode("stable content\n")
    );
    const tour: CodeTour = {
      id: "https://example.invalid/readonly.tour",
      title: "Read-only",
      steps: [
        {
          file: "readonly.txt",
          description: "read-only content",
          anchor: { type: "content", text: "stable content" }
        }
      ]
    };
    store.activeTour = {
      tour,
      step: 0,
      canEditTour: false,
      workspaceRoot: getWorkspaceRoot(),
      thread: null
    };

    try {
      await anchorResolver.resolveStep(tour, 0);
      const document = await vscode.workspace.openTextDocument(fileUri);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(0, 0, 0, 6), "changed");
      assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
      await new Promise(resolve => setTimeout(resolve, 700));
      assert.strictEqual(tour.steps[0].anchor?.type, "content");
      assert.strictEqual(
        tour.steps[0].anchor?.type === "content" &&
          tour.steps[0].anchor.text,
        "stable content"
      );
    } finally {
      store.activeTour = null;
    }
  });

  it("treats Live Share and remote URLs as read-only tour sources", () => {
    assert.strictEqual(isWritableTourUri(vscode.Uri.parse("vsls:/shared.tour")), false);
    assert.strictEqual(
      isWritableTourUri(vscode.Uri.parse("https://example.invalid/tour")),
      false
    );
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
      steps: [
        {
          description: "line anchor",
          file: "sample.txt",
          anchor: { type: "line", number: 2 }
        }
      ]
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
    const differentlyCasedDriveUri = tourUri.with({
      path: tourUri.path.replace(
        /^\/([A-Z]):/,
        (_, drive: string) => `/${drive.toLocaleLowerCase()}:`
      )
    });
    assert.strictEqual(
      getTourSchemaReference(differentlyCasedDriveUri),
      "./schema.json"
    );
    await vscode.workspace.fs.stat(
      vscode.Uri.joinPath(getWorkspaceRoot(), ".tours", "schema.json")
    );

    const nestedTourUri = vscode.Uri.joinPath(
      getWorkspaceRoot(),
      ".tours",
      "nested",
      "nested.tour"
    );
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(getWorkspaceRoot(), ".tours", "nested")
    );
    await vscode.workspace.fs.writeFile(
      nestedTourUri,
      new TextEncoder().encode(JSON.stringify(original))
    );
    assert.strictEqual(await migrateTourSchema(nestedTourUri), true);
    const nestedTour = JSON.parse(
      new TextDecoder().decode(
        await vscode.workspace.fs.readFile(nestedTourUri)
      )
    );
    assert.strictEqual(nestedTour.$schema, "./schema.json");
    await vscode.workspace.fs.stat(
      vscode.Uri.joinPath(getWorkspaceRoot(), ".tours", "nested", "schema.json")
    );
  });

  it("preserves a conflicting schema file beside a tour", async () => {
    const directoryUri = vscode.Uri.joinPath(
      getWorkspaceRoot(),
      "schema-conflict"
    );
    const schemaUri = vscode.Uri.joinPath(directoryUri, "schema.json");
    const tourUri = vscode.Uri.joinPath(directoryUri, "conflict.tour");
    const customSchema = '{"title":"Application schema"}\n';
    await vscode.workspace.fs.createDirectory(directoryUri);
    await vscode.workspace.fs.writeFile(
      schemaUri,
      new TextEncoder().encode(customSchema)
    );
    const tour: CodeTour = {
      id: tourUri.toString(),
      title: "Schema Conflict",
      steps: []
    };

    await assert.rejects(() => saveTour(tour));
    assert.strictEqual(
      new TextDecoder().decode(await vscode.workspace.fs.readFile(schemaUri)),
      customSchema
    );
  });

  it("persists virtual content edits as decoded text", async () => {
    const tour = createTour({
      file: "embedded.txt",
      description: "embedded content",
      contents: "before",
      anchor: { type: "line", number: 1 }
    });
    store.activeTour = {
      tour,
      step: 0,
      workspaceRoot: getWorkspaceRoot(),
      thread: null
    };

    try {
      const provider = new CodeTourFileSystemProvider();
      const virtualUri = getEmbeddedStepUri(tour, 0, "embedded.txt");
      await provider.writeFile(
        virtualUri,
        new TextEncoder().encode("after\ncontent"),
        { create: false, overwrite: true }
      );

      assert.strictEqual(
        store.activeTour!.tour.steps[0].contents,
        "after\ncontent"
      );
      const persisted = JSON.parse(
        new TextDecoder().decode(
          await vscode.workspace.fs.readFile(vscode.Uri.parse(tour.id))
        )
      );
      assert.strictEqual(persisted.steps[0].contents, "after\ncontent");
      assert.deepStrictEqual(persisted.steps[0].anchor, {
        type: "line",
        number: 1
      });
    } finally {
      store.activeTour = null;
    }
  });

  it("normalizes legacy integer SymbolKinds when saving", async () => {
    const tour = createTour({
      file: "sample.txt",
      description: "legacy symbol kind",
      anchor: {
        type: "symbol",
        path: [{ name: "betaMember", kind: vscode.SymbolKind.Method }]
      }
    });
    await saveTour(tour);
    const persisted = JSON.parse(
      new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.parse(tour.id))
      )
    );
    assert.strictEqual(persisted.steps[0].anchor.path[0].kind, "Method");
  });

  it("isolates embedded files by tour and step identity", async () => {
    const tour = createTour({
      file: "first.txt",
      description: "first",
      contents: "first content",
      anchor: { type: "line", number: 1 }
    });
    tour.steps.push({
      file: "second.txt",
      description: "second",
      contents: "second content",
      anchor: { type: "line", number: 1 }
    });
    store.activeTour = {
      tour,
      step: 1,
      workspaceRoot: getWorkspaceRoot(),
      thread: null
    };

    try {
      const provider = new CodeTourFileSystemProvider();
      const firstUri = getEmbeddedStepUri(tour, 0, "first.txt");
      const secondUri = getEmbeddedStepUri(tour, 1, "second.txt");
      assert.strictEqual(
        new TextDecoder().decode(await provider.readFile(firstUri)),
        "first content"
      );
      assert.strictEqual(
        new TextDecoder().decode(await provider.readFile(secondUri)),
        "second content"
      );
    } finally {
      store.activeTour = null;
    }
  });

  it("refreshes tours after external create, change, and delete events in every mode", async () => {
    const tourUri = vscode.Uri.joinPath(
      getWorkspaceRoot(),
      ".tours",
      "watched.tour"
    );
    const write = (title: string) =>
      vscode.workspace.fs.writeFile(
        tourUri,
        new TextEncoder().encode(
          JSON.stringify({ title, steps: [{ description: "watched" }] })
        )
      );

    store.isEditing = true;
    await write("Watcher Created");
    await waitFor(() =>
      store.tours.some(tour => tour.title === "Watcher Created")
    );

    store.isEditing = false;
    await write("Watcher Changed");
    await waitFor(() =>
      store.tours.some(tour => tour.title === "Watcher Changed")
    );

    await vscode.workspace.fs.delete(tourUri);
    await waitFor(() =>
      store.tours.every(tour => tour.title !== "Watcher Changed")
    );
  });

  it("refreshes the panel model immediately after internal tour saves", async () => {
    const tour = createTour({
      description: "saved",
      file: "sample.txt",
      anchor: { type: "line", number: 1 }
    });
    tour.id = vscode.Uri.joinPath(
      getWorkspaceRoot(),
      ".tours",
      "internally-saved.tour"
    ).toString();
    tour.title = "Internal Save Created";
    tour.$schema = "https://example.invalid/obsolete-schema.json";
    await saveTour(tour);
    await waitFor(() =>
      store.tours.some(candidate => candidate.title === "Internal Save Created")
    );
    const persisted = JSON.parse(
      new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.parse(tour.id))
      )
    );
    assert.strictEqual(persisted.$schema, "./schema.json");

    tour.title = "Internal Save Changed";
    await saveTour(tour);
    await waitFor(() =>
      store.tours.some(candidate => candidate.title === "Internal Save Changed")
    );
  });

  it("uses dirty tour document contents for live panel updates", async () => {
    const tourUri = vscode.Uri.joinPath(
      getWorkspaceRoot(),
      ".tours",
      "live-edit.tour"
    );
    await vscode.workspace.fs.writeFile(
      tourUri,
      new TextEncoder().encode(
        JSON.stringify({ title: "Live Before", steps: [] }, null, 2)
      )
    );
    await waitFor(() => store.tours.some(tour => tour.title === "Live Before"));

    const document = await vscode.workspace.openTextDocument(tourUri);
    const edit = new vscode.WorkspaceEdit();
    const title = document.getText().indexOf("Live Before");
    edit.replace(
      tourUri,
      new vscode.Range(
        document.positionAt(title),
        document.positionAt(title + "Live Before".length)
      ),
      "Live Dirty"
    );
    assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
    await waitFor(() => store.tours.some(tour => tour.title === "Live Dirty"));
    assert.strictEqual(await document.save(), true);
  });

  it("keeps the last valid panel model while a dirty tour is malformed", async () => {
    const tourUri = vscode.Uri.joinPath(
      getWorkspaceRoot(),
      ".tours",
      "malformed-live-edit.tour"
    );
    const validContents = JSON.stringify(
      { title: "Valid Live Tour", steps: [{ description: "valid" }] },
      null,
      2
    );
    await vscode.workspace.fs.writeFile(
      tourUri,
      new TextEncoder().encode(validContents)
    );
    await waitFor(() =>
      store.tours.some(tour => tour.title === "Valid Live Tour")
    );

    const document = await vscode.workspace.openTextDocument(tourUri);
    const malformedContents = JSON.stringify(
      { title: "Malformed Live Tour", steps: [null] },
      null,
      2
    );
    const malformedEdit = new vscode.WorkspaceEdit();
    malformedEdit.replace(
      tourUri,
      new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      ),
      malformedContents
    );
    assert.strictEqual(await vscode.workspace.applyEdit(malformedEdit), true);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(store.tours.some(tour => tour.title === "Valid Live Tour"));
    assert.ok(store.tours.every(tour => tour.title !== "Malformed Live Tour"));

    const restoreEdit = new vscode.WorkspaceEdit();
    restoreEdit.replace(
      tourUri,
      new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      ),
      validContents
    );
    assert.strictEqual(await vscode.workspace.applyEdit(restoreEdit), true);
    assert.strictEqual(await document.save(), true);
  });

  it("restores the active step after an external tour reorder", async () => {
    const tourUri = vscode.Uri.joinPath(
      getWorkspaceRoot(),
      ".tours",
      "reordered.tour"
    );
    const first = {
      description: "first",
      file: "sample.txt",
      anchor: { type: "line" as const, number: 1 }
    };
    const second = {
      description: "second",
      file: "sample.txt",
      anchor: { type: "line" as const, number: 2 }
    };
    await vscode.workspace.fs.writeFile(
      tourUri,
      new TextEncoder().encode(
        JSON.stringify({ title: "Reordered", steps: [first, second] })
      )
    );
    await waitFor(() => store.tours.some(tour => tour.title === "Reordered"));
    const tour = store.tours.find(
      candidate => candidate.title === "Reordered"
    )!;
    store.activeTour = {
      tour,
      step: 1,
      workspaceRoot: getWorkspaceRoot(),
      thread: null
    };

    await vscode.workspace.fs.writeFile(
      tourUri,
      new TextEncoder().encode(
        JSON.stringify({ title: "Reordered", steps: [second, first] })
      )
    );
    await waitFor(
      () =>
        store.activeTour?.tour.steps[0].description === "second" &&
        store.activeTour.step === 0
    );
    store.activeTour = null;
  });

  it("preserves unrelated external changes during an active step edit", async () => {
    const tourId = "https://example.invalid/external-edit.tour";
    const activeTour: CodeTour = {
      id: tourId,
      title: "External Edit",
      steps: [
        { description: "editing" },
        { description: "before external change" }
      ]
    };
    const comment = {
      body: "local draft",
      savedBody: "editing",
      mode: vscode.CommentMode.Editing
    } as vscode.Comment & { savedBody: string };
    const thread = {
      comments: [comment],
      dispose() {}
    } as unknown as vscode.CommentThread;
    store.activeTour = {
      tour: activeTour,
      step: 0,
      canEditTour: true,
      thread
    };
    store.isEditing = true;

    try {
      const externalTour: CodeTour = {
        id: tourId,
        title: "External Edit",
        steps: [
          { description: "editing" },
          { description: "after external change" }
        ]
      };
      assert.strictEqual(mergeExternalTourDuringEdit(externalTour), true);
      assert.strictEqual(
        store.activeTour.tour.steps[1].description,
        "after external change"
      );
      await cancelActiveTourEdit();
      assert.strictEqual(
        store.activeTour.tour.steps[1].description,
        "after external change"
      );
    } finally {
      store.activeTour = null;
      store.isEditing = false;
    }
  });

  it("opens the CodeTour view inside Explorer", async () => {
    const manifest = JSON.parse(
      new TextDecoder().decode(
        await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(extensionUri, "package.json")
        )
      )
    );
    assert.ok(
      manifest.contributes.views.explorer.some(
        (view: { id: string }) => view.id === "codetour.tours"
      )
    );
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("codetour.openCodeTourPanel"));
    manifest.contributes.commands.forEach(({ command }: { command: string }) =>
      assert.ok(commands.includes(command), `Command is not registered: ${command}`)
    );
    await vscode.commands.executeCommand("codetour.openCodeTourPanel");
  });

  it("creates a standard CodeTour authoring skill", async () => {
    await vscode.commands.executeCommand("codetour.createCodeTourSkill");
    const skillUri = vscode.Uri.joinPath(
      getWorkspaceRoot(),
      ".tours",
      "SKILL.md"
    );
    const contents = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(skillUri)
    );
    assert.match(contents, /^---\nname: codetour-authoring\n/);
    assert.match(contents, /## Balance Detail and Step Count/);
    assert.match(contents, /"\$schema": "\.\/schema\.json"/);
  });
});
