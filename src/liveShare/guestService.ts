// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vsls from "vsls";
import { EXTENSION_NAME } from "../constants";
import { endCurrentCodeTour, startCodeTour } from "../store/actions";
import initializeBaseService from "./service";

export async function initializeService(vslsApi: vsls.LiveShare) {
  const service = await vslsApi.getSharedService(EXTENSION_NAME);
  if (!service) return;

  const response = await service.request("getCurrentTourStep", []);
  if (response) {
    if (!(await endCurrentCodeTour(false))) {
      return;
    }
    startCodeTour(
      response.tour,
      response.stepNumber,
      undefined,
      false,
      false,
      undefined,
      false
    );
  }

  return initializeBaseService(vslsApi, service);
}
