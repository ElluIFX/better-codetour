// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vsls from "vsls";
import { Disposable, ExtensionContext } from "vscode";
import { EXTENSION_NAME } from "../constants";

let activeSessionKey: string | undefined;
let activeService: Disposable | undefined;

export async function registerLiveShareModule(context: ExtensionContext) {
  const vslsApi = await vsls.getApi(`vsls-contrib.${EXTENSION_NAME}`);
  if (!vslsApi) return;

  context.subscriptions.push(
    vslsApi.onDidChangeSession(() => {
      void initializeService(vslsApi).catch(error =>
        console.warn("Unable to initialize CodeTour Live Share.", error)
      );
    }),
    new Disposable(() => activeService?.dispose())
  );

  await initializeService(vslsApi);
}

async function initializeService(vslsApi: vsls.LiveShare) {
  const sessionKey = vslsApi.session.id
    ? `${vslsApi.session.id}:${vslsApi.session.role}`
    : undefined;
  if (sessionKey === activeSessionKey) {
    return;
  }
  activeService?.dispose();
  activeService = undefined;
  activeSessionKey = sessionKey;
  if (!sessionKey) {
    return;
  }

  let { initializeService } =
    vslsApi.session.role === vsls.Role.Host
      ? require("./hostService")
      : require("./guestService");

  activeService = await initializeService(vslsApi);
}
