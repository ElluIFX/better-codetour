import { CodeTour, CodeTourAnchor, CodeTourStep } from ".";
import { normalizeSymbolKind } from "../symbolKind";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function isAnchor(value: unknown): value is CodeTourAnchor {
  if (!isObject(value)) {
    return false;
  }

  if (value.type === "line") {
    return (
      Number.isInteger(value.number) &&
      typeof value.number === "number" &&
      value.number > 0
    );
  }

  if (value.type === "content") {
    return typeof value.text === "string" && value.text.length > 0;
  }

  if (value.type === "symbol") {
    return (
      Array.isArray(value.path) &&
      value.path.length > 0 &&
      value.path.every(
        segment =>
          isObject(segment) &&
          typeof segment.name === "string" &&
          segment.name.length > 0 &&
          (typeof segment.kind === "string" ||
            typeof segment.kind === "number") &&
          normalizeSymbolKind(
            segment.kind as Parameters<typeof normalizeSymbolKind>[0]
          ) !== undefined
      )
    );
  }

  return false;
}

function isStep(value: unknown): value is CodeTourStep {
  if (!isObject(value) || typeof value.description !== "string") {
    return false;
  }
  if (
    !isOptionalString(value.title) ||
    !isOptionalString(value.icon) ||
    !isOptionalString(value.file) ||
    !isOptionalString(value.directory) ||
    !isOptionalString(value.contents) ||
    !isOptionalString(value.uri) ||
    !isOptionalString(value.view) ||
    (value.commands !== undefined &&
      (!Array.isArray(value.commands) ||
        !value.commands.every(command => typeof command === "string")))
  ) {
    return false;
  }

  const hasFile = value.file !== undefined;
  const hasDirectory = value.directory !== undefined;
  const hasUri = value.uri !== undefined;
  const hasView = value.view !== undefined;
  const targetCount = [hasFile, hasDirectory, hasUri, hasView].filter(
    Boolean
  ).length;
  if (targetCount > 1 || (value.contents !== undefined && !hasFile)) {
    return false;
  }
  if (hasFile) {
    return isAnchor(value.anchor);
  }
  return value.anchor === undefined;
}

export function validateCodeTour(value: unknown): asserts value is CodeTour {
  if (
    !isObject(value) ||
    typeof value.title !== "string" ||
    value.title.length === 0 ||
    !Array.isArray(value.steps) ||
    !value.steps.every(isStep) ||
    !isOptionalString(value.$schema) ||
    !isOptionalString(value.description) ||
    !isOptionalString(value.ref) ||
    !isOptionalString(value.nextTour) ||
    !isOptionalString(value.when) ||
    (value.isPrimary !== undefined && typeof value.isPrimary !== "boolean")
  ) {
    throw new Error("The value does not match the CodeTour format.");
  }
}

export function parseCodeTour(source: string | unknown, id: string): CodeTour {
  const value = typeof source === "string" ? JSON.parse(source) : source;
  validateCodeTour(value);
  value.id = id;
  return value;
}
