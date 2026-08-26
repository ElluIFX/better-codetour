export const SYMBOL_KIND_NAMES = [
  "File",
  "Module",
  "Namespace",
  "Package",
  "Class",
  "Method",
  "Property",
  "Field",
  "Constructor",
  "Enum",
  "Interface",
  "Function",
  "Variable",
  "Constant",
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Key",
  "Null",
  "EnumMember",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter"
] as const;

export type CodeTourSymbolKindName = (typeof SYMBOL_KIND_NAMES)[number];
export type CodeTourSymbolKind = CodeTourSymbolKindName | number;

export function normalizeSymbolKind(
  kind: CodeTourSymbolKind
): CodeTourSymbolKindName | undefined {
  if (typeof kind === "number") {
    return Number.isInteger(kind) ? SYMBOL_KIND_NAMES[kind] : undefined;
  }

  return SYMBOL_KIND_NAMES.includes(kind) ? kind : undefined;
}

export function symbolKindsEqual(
  left: CodeTourSymbolKind,
  right: CodeTourSymbolKind
) {
  const normalizedLeft = normalizeSymbolKind(left);
  return normalizedLeft !== undefined && normalizedLeft === normalizeSymbolKind(right);
}
