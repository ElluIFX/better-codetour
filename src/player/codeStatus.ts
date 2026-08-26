import * as vscode from "vscode";
import { onDidEndTour, onDidStartTour } from "../store/actions";

export async function registerCodeStatusModule(
  context: vscode.ExtensionContext
) {
  const extension = vscode.extensions.getExtension("lostintangent.codestatus");
  if (!extension) {
    return;
  }

  if (!extension.isActive) {
    await extension.activate();
  }

  let statusDisposable: vscode.Disposable;
  const startDisposable = onDidStartTour(async ([tour, stepNumber]) => {
    const disposeable = await extension.exports.updateStatus({
      emoji: "🗺️",
      message: vscode.l10n.t(
        "CodeTour: {0} (#{1} of {2})",
        tour.title,
        stepNumber + 1,
        tour.steps.length
      ),
      limitedAvailability: true
    });

    if (!statusDisposable) {
      statusDisposable = disposeable;
    }
  });

  const endDisposable = onDidEndTour(
    () => statusDisposable && statusDisposable.dispose()
  );
  context.subscriptions.push(startDisposable, endDisposable);
}
