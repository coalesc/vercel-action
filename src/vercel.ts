import * as core from "@actions/core";
import * as exec from "@actions/exec";

import packageJSON from "../package.json" assert { type: "json" };

export class Vercel {
  private token = core.getInput("vercel-token", { required: true });
  private orgId = core.getInput("vercel-org-id", { required: true });
  private projectId = core.getInput("vercel-project-id", { required: true });
  private privProjectName = core.getInput("vercel-project-name");
  private scope = core.getInput("scope");
  private args = core.getInput("vercel-args");
  private bin =
    `vercel@${core.getInput("vercel-version") || packageJSON.dependencies.vercel}`;

  get projectName() {
    return this.privProjectName;
  }

  async setEnv() {
    core.info("Setting environment variables for Vercel CLI");
    if (this.orgId) core.exportVariable("VERCEL_ORG_ID", this.orgId);
    if (this.projectId)
      core.exportVariable("VERCEL_PROJECT_ID", this.projectId);
  }

  async disableTelemetry() {
    core.info("Disabling telemetry for Vercel CLI");
    await exec.exec("vercel", ["telemetry", "disable"]);
  }

  async deploy(ref: string, commit: string) {
    const args = [...this.parseArgs(this.args), ...["-t", this.token]];
    if (this.scope) {
      core.info("using scope");
      args.push("--scope", this.scope);
    }

    let deploymentUrl = "";
    let inspectUrl = "";
    await exec.exec("npx", [this.bin, ...args], {
      listeners: {
        stdout: (data) => {
          deploymentUrl += data.toString();
        },
        stderr: (data) => {
          if (data.toString().startsWith("Inspect: https://vercel.com"))
            inspectUrl = data.toString().replace("Inspect: ", "");
        },
      },
    });

    return { deploymentUrl, inspectUrl };
  }

  async inspect(deploymentUrl: string) {
    const args = [this.bin, "inspect", deploymentUrl, "-t", this.token];
    if (this.scope) {
      core.info("using scope");
      args.push("--scope", this.scope);
    }

    let error = "";
    await exec.exec("npx", args, {
      listeners: {
        stderr: (data) => {
          error += data.toString();
        },
      },
    });

    const match = error.match(/^\s+name\s+(.+)$/m);
    return match?.length ? match[1] : null;
  }

  private addMetadata(
    key: string,
    value: string | number,
    providedArgs: string[],
  ) {
    const metadataRegex = new RegExp(`^${key}=.+`, "g");
    for (const arg of providedArgs) {
      if (arg.match(metadataRegex)) {
        return [];
      }
    }

    return ["-m", `${key}=${value}`];
  }

  private parseArgs(s: string) {
    const args = [];
    for (const match of s.matchAll(/'([^']*)'|"([^"]*)"|[^\s]+/gm)) {
      args.push(match[1] ?? match[2] ?? match[0]);
    }

    return args;
  }
}
