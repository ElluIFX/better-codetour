import * as vscode from "vscode";
import { CodeTour, store } from ".";

const READ_ONLY_SCHEMES = new Set(["http", "https", "vsls"]);

export function isWritableTourUri(uri: vscode.Uri) {
  return (
    !READ_ONLY_SCHEMES.has(uri.scheme) &&
    vscode.workspace.fs.isWritableFileSystem(uri.scheme) !== false
  );
}

export function isWritableTourSource(tour: CodeTour) {
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(tour.id, true);
  } catch {
    return false;
  }
  if (!isWritableTourUri(uri)) {
    return false;
  }
  return store.activeTour?.tour.id === tour.id
    ? store.activeTour.canEditTour !== false
    : store.tours.some(candidate => candidate.id === tour.id);
}
