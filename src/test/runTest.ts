// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main() {
  const workspacePath = await fs.mkdtemp(
    path.join(os.tmpdir(), "better-codetour-")
  );
  try {
    await fs.writeFile(
      path.join(workspacePath, "sample.txt"),
      "alpha\r\nbeta\r\nalpha\r\nbeta\r\n",
      "utf8"
    );
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, "../.."),
      extensionTestsPath: path.resolve(__dirname, "suite"),
      launchArgs: [workspacePath, "--locale=zh-cn"]
    });
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
