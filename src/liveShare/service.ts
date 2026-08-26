// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Disposable, Uri } from "vscode";
import { LiveShare, Role, SharedService, SharedServiceProxy } from "vsls";
import {
  endCurrentCodeTour,
  onDidEndTour,
  onDidStartTour,
  startCodeTour
} from "../store/actions";

interface Message {
  data?: any;
  peer?: number;
}

const TOUR_ENDED_NOTIFICATION = "tourEnded";
const TOUR_STARTED_NOTIFICATION = "tourStarted";

export default function (
  api: LiveShare,
  service: SharedService | SharedServiceProxy
) {
  const peer = api.session.peerNumber;
  const disposables: Disposable[] = [];

  disposables.push(
    onDidEndTour(() => {
      service.notify(TOUR_ENDED_NOTIFICATION, { peer });
    })
  );

  service.onNotify(TOUR_ENDED_NOTIFICATION, async (message: Message) => {
    if (message.peer === peer) return;

    if (
      (await endCurrentCodeTour(false)) &&
      api.session.role === Role.Host
    ) {
      service.notify(TOUR_ENDED_NOTIFICATION, message);
    }
  });

  disposables.push(
    onDidStartTour(([tour, stepNumber]) => {
      const newTour = { ...tour };

      if (api.session.role === Role.Host) {
        newTour.id = api.convertLocalUriToShared(Uri.parse(tour.id)).toString();
      }

      const message = {
        peer,
        data: {
          tour: newTour,
          stepNumber
        }
      };

      service.notify(TOUR_STARTED_NOTIFICATION, message);
    })
  );

  service.onNotify(TOUR_STARTED_NOTIFICATION, async (message: Message) => {
    if (message.peer === peer) return;

    const incomingTour = { ...message.data.tour };
    if (api.session.role === Role.Host) {
      incomingTour.id = api
        .convertSharedUriToLocal(Uri.parse(incomingTour.id))
        .toString();
    }
    if (!(await endCurrentCodeTour(false))) {
      return;
    }
    startCodeTour(
      incomingTour,
      message.data.stepNumber,
      undefined,
      false,
      false,
      undefined,
      false
    );
    if (api.session.role === Role.Host) {
      service.notify(TOUR_STARTED_NOTIFICATION, message);
    }
  });

  return new Disposable(() =>
    disposables.forEach(disposable => disposable.dispose())
  );
}
