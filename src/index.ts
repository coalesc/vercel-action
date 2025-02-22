import * as core from "@actions/core";
import * as github from "@actions/github";
import type { PullRequestEvent, PushEvent } from "@octokit/webhooks-types";
import { Rest } from "./rest.js";
import { Vercel } from "./vercel.js";

const vercel = new Vercel();
const rest = new Rest();

async function run() {
  if (rest.isPullRequestType(github.context.eventName)) {
    const payload = github.context.payload as PullRequestEvent;

    const baseRepo = payload.pull_request.base.repo;
    if (github.context.repo.owner !== baseRepo.owner.login) {
      core.info("Repository is forked, skipping deployment");
      return;
    }
  }

  let { ref, sha } = github.context;
  await vercel.setEnv();

  let commitMessage = "";
  if (github.context.eventName === "push") {
    const pushPayload = github.context.payload as PushEvent;
    commitMessage = pushPayload.head_commit?.message ?? "";
  } else if (rest.isPullRequestType(github.context.eventName)) {
    const prPayload = github.context.payload as PullRequestEvent;

    ref = prPayload.pull_request.head.ref;
    sha = prPayload.pull_request.head.sha.slice(0, 7);

    const { data } = await rest.octokit.rest.git.getCommit({
      ...github.context.repo,
      commit_sha: sha,
    });
    commitMessage = data.message;
  }

  core.startGroup("Deploying to Vercel");
  const deploymentUrl = await vercel.deploy(ref, commitMessage);
  if (!deploymentUrl) {
    core.warning("Couldn't get preview URL");
  }
  core.endGroup();

  core.startGroup("Inspecting deployment");
  const deploymentName =
    vercel.projectName || (await vercel.inspect(deploymentUrl));
  if (!deploymentName) {
    core.warning("get preview-name error");
  }
  core.endGroup();

  core.startGroup("Adding or updating comment");
  if (deploymentName) {
    if (github.context.issue.number) {
      await rest.createCommentOnPullRequest({
        commitSha: sha,
        name: deploymentName,
        previewUrl: deploymentUrl,
        inspectorUrl: `${deploymentUrl}/inspect`,
      });
    } else if (github.context.eventName === "push") {
      await rest.createCommentOnCommit({
        commitSha: sha,
        name: deploymentName,
        previewUrl: deploymentUrl,
        inspectorUrl: `${deploymentUrl}/inspect`,
      });
    }
  }
  core.endGroup();
}

(async () => {
  try {
    await run();
  } catch (error: unknown) {
    core.setFailed((error as { message: string }).message);
  }
})();
