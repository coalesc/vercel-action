import * as core from "@actions/core";
import * as github from "@actions/github";
import type {
  IssueCommentEvent,
  PullRequestEvent,
  PushEvent,
} from "@octokit/webhooks-types";
import { Rest } from "./rest.js";
import { Vercel } from "./vercel.js";

const vercel = new Vercel();
const rest = new Rest();

let deploymentId = Number.NaN;
async function run() {
  let { ref, sha } = github.context;

  const forkBody = [
    "⚠️ This PR is from a repository outside your account so it will not be deployed.",
    "",
    `If you are a collaborator on this project and you wish to allow **@${github.context.actor}** to deploy this commit, press the checkbox below.`,
    "- [ ] Allow deployment",
  ].join("\n");
  if (rest.isPullRequestType(github.context.eventName)) {
    const payload = github.context.payload as PullRequestEvent;

    const baseRepo = payload.pull_request.base.repo;
    if (github.context.repo.owner !== baseRepo.owner.login) {
      core.startGroup("Setting forked comment");
      await rest.createComment({ body: forkBody });
      core.endGroup();

      return;
    }
  } else if (github.context.eventName === "issue_comment") {
    const payload = github.context.payload as IssueCommentEvent;
    if (
      payload.issue.state === "open" &&
      payload.comment.body.includes("- [x] Allow deployment")
    ) {
      if (!(await rest.checkCollaborator())) {
        core.startGroup("Setting forked comment");
        await rest.createComment({ body: forkBody });
        core.endGroup();

        return;
      }
    } else {
      return;
    }
  }

  let commitMessage = "";
  if (github.context.eventName === "push") {
    const pushPayload = github.context.payload as PushEvent;
    commitMessage = pushPayload.head_commit?.message ?? "";
  } else if (rest.isPullRequestType(github.context.eventName)) {
    const prPayload = github.context.payload as PullRequestEvent;

    ref = prPayload.pull_request.head.ref;
    sha = prPayload.pull_request.head.sha;

    const { data } = await rest.octokit.rest.git.getCommit({
      ...github.context.repo,
      commit_sha: sha,
    });
    commitMessage = data.message;
  }

  core.startGroup("Setting deployment status");
  const { status, data } = await rest.createDeployment(ref);
  console.log(data);
  if (status !== 201) {
    core.warning("Couldn't create deployment");
  } else {
    deploymentId = data.id;
    await rest.updateDeployment(deploymentId, "pending");
  }
  core.endGroup();

  core.startGroup("Setting pending comment");
  await rest.createComment({ commitSha: sha });
  core.endGroup();

  await vercel.setEnv();
  core.startGroup("Disabling telemetry for Vercel CLI");
  await vercel.disableTelemetry();
  core.endGroup();

  core.startGroup("Deploying to Vercel");
  const { deploymentUrl, inspectUrl } = await vercel.deploy(ref, commitMessage);
  if (!deploymentUrl || !inspectUrl)
    core.warning("Couldn't get deployment or inspect URL");
  core.endGroup();

  core.startGroup("Inspecting deployment");
  const deploymentName =
    vercel.projectName || (await vercel.inspect(deploymentUrl));
  if (!deploymentName) core.warning("Couldn't get deployment name");
  core.endGroup();

  core.startGroup("Setting ready comment");
  await rest.createComment({
    inspectUrl,
    deploymentUrl,
    commitSha: sha,
    name: deploymentName ?? undefined,
  });
  core.endGroup();

  core.startGroup("Updating deployment status");
  if (!Number.isNaN(deploymentId))
    await rest.updateDeployment(deploymentId, "success", {
      deploymentUrl,
      inspectUrl,
    });
  core.endGroup();
}

(async () => {
  try {
    await run();
  } catch (error: unknown) {
    core.startGroup("Updating deployment status");
    if (!Number.isNaN(deploymentId))
      await rest.updateDeployment(deploymentId, "failure");
    core.endGroup();

    core.setFailed((error as { message: string }).message);
  }
})();
