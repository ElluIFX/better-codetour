// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { observable } from "mobx";
import { CommentThread, Uri } from "vscode";
import { CodeTourSymbolKind } from "../symbolKind";

export interface CodeTourSymbolPathSegment {
  name: string;
  kind: CodeTourSymbolKind;
}

export interface CodeTourSymbolAnchor {
  type: "symbol";
  path: CodeTourSymbolPathSegment[];
}

export interface CodeTourContentAnchor {
  type: "content";
  text: string;
}

export interface CodeTourLineAnchor {
  type: "line";
  number: number;
}

export type CodeTourAnchor =
  | CodeTourLineAnchor
  | CodeTourSymbolAnchor
  | CodeTourContentAnchor;

export type CodeTourAnchorState =
  | "pending"
  | "resolved"
  | "unresolved"
  | "unsupported"
  | "ambiguous";

export interface CodeTourStep {
  title?: string;
  description: string;
  icon?: string;

  // If any of the following are set, then only
  // one of them can be, since these properties
  // indicate the "type" of step.
  file?: string;
  directory?: string;
  contents?: string;
  uri?: string;
  view?: string;

  commands?: string[];
  anchor?: CodeTourAnchor;
}

export interface CodeTour {
  $schema?: string;
  id: string;
  title: string;
  description?: string;
  steps: CodeTourStep[];
  ref?: string;
  isPrimary?: boolean;
  nextTour?: string;
  when?: string;
}

export interface ActiveTour {
  tour: CodeTour;
  step: number;
  canEditTour?: boolean;

  // When recording, a tour can be active, without
  // having created an actual comment yet.
  thread: CommentThread | null | undefined;

  // In order to resolve relative file
  // paths, we need to know the workspace root
  workspaceRoot?: Uri;

  // In order to resolve inter-tour
  // links, the active tour might need
  // the context of its sibling tours, if
  // they're coming from somewhere other
  // then the active workspace (e.g. a
  // GistPad-managed repo).
  tours?: CodeTour[];
}

type CodeTourProgress = [string, number[]];
export type CodeTourStepTuple = [CodeTour, CodeTourStep, number, number?];

export interface Store {
  tours: CodeTour[];
  activeTour: ActiveTour | null;
  activeEditorSteps?: CodeTourStepTuple[];
  hasTours: boolean;
  isRecording: boolean;
  isEditing: boolean;
  showMarkers: boolean;
  progress: CodeTourProgress[];
}

export const store: Store = observable({
  tours: [],
  activeTour: null,
  isRecording: false,
  isEditing: false,
  get hasTours() {
    return this.tours.length > 0;
  },
  showMarkers: false,
  progress: []
});
