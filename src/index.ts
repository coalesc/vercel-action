import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import type { PullRequestEvent, PushEvent } from "@octokit/webhooks-types";
import packageJSON from "../package.json" assert { type: "json" };

function isPullRequestType(event: string) {
  return event.startsWith("pull_request");
}

const githubToken = core.getInput("github-token", { required: true });
const vercel = {
  token: core.getInput("vercel-token", { required: true }),
  orgId: core.getInput("vercel-org-id", { required: true }),
  projectId: core.getInput("vercel-project-id", { required: true }),
  projectName: core.getInput("vercel-project-name"),
  scope: core.getInput("scope"),
  args: core.getInput("vercel-args"),
  bin: `vercel@${core.getInput("vercel-version") || packageJSON.dependencies.vercel}`,
};

const octokit = github.getOctokit(githubToken);

async function setEnv() {
  core.info("Set environment data for Vercel CLI");
  if (vercel.orgId) {
    core.info("Set env variable: VERCEL_ORG_ID");
    core.exportVariable("VERCEL_ORG_ID", vercel.orgId);
  }
  if (vercel.projectId) {
    core.info("Set env variable: VERCEL_PROJECT_ID");
    core.exportVariable("VERCEL_PROJECT_ID", vercel.projectId);
  }
}

function addVercelMetadata(
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

function parseArgs(s: string) {
  const args = [];
  for (const match of s.matchAll(/'([^']*)'|"([^"]*)"|[^\s]+/gm)) {
    args.push(match[1] ?? match[2] ?? match[0]);
  }

  return args;
}

async function vercelDeploy(ref: string, commit: string) {
  const providedArgs = parseArgs(vercel.args);

  const args = [
    ...providedArgs,
    ...["-t", vercel.token],
    ...addVercelMetadata("githubCommitSha", github.context.sha, providedArgs),
    ...addVercelMetadata(
      "githubCommitAuthorName",
      github.context.actor,
      providedArgs,
    ),
    ...addVercelMetadata(
      "githubCommitAuthorLogin",
      github.context.actor,
      providedArgs,
    ),
    ...addVercelMetadata("githubDeployment", 1, providedArgs),
    ...addVercelMetadata("githubOrg", github.context.repo.owner, providedArgs),
    ...addVercelMetadata("githubRepo", github.context.repo.repo, providedArgs),
    ...addVercelMetadata(
      "githubCommitOrg",
      github.context.repo.owner,
      providedArgs,
    ),
    ...addVercelMetadata(
      "githubCommitRepo",
      github.context.repo.repo,
      providedArgs,
    ),
    ...addVercelMetadata("githubCommitMessage", `"${commit}"`, providedArgs),
    ...addVercelMetadata(
      "githubCommitRef",
      ref.replace("refs/heads/", ""),
      providedArgs,
    ),
  ];

  if (vercel.scope) {
    core.info("using scope");
    args.push("--scope", vercel.scope);
  }

  let output = "";
  await exec.exec("npx", [vercel.bin, ...args], {
    listeners: {
      stdout: (data) => {
        output += data.toString();
        core.info(data.toString());
      },
    },
  });

  console.log(output);
  return output;
}

async function vercelInspect(deploymentUrl: string) {
  const args = [vercel.bin, "inspect", deploymentUrl, "-t", vercel.token];
  if (vercel.scope) {
    core.info("using scope");
    args.push("--scope", vercel.scope);
  }

  let error = "";
  await exec.exec("npx", args, {
    listeners: {
      stderr: (data) => {
        error += data.toString();
        core.info(data.toString());
      },
    },
  });

  const match = error.match(/^\s+name\s+(.+)$/m);
  return match?.length ? match[1] : null;
}

interface Comment {
  id: number;
  body?: string;
}

async function findCommentsForEvent(): Promise<{ data: Comment[] }> {
  const defaultResponse = {
    data: [] as Comment[],
  };

  if (github.context.eventName === "push") {
    const response = await octokit?.rest.repos
      .listCommentsForCommit({
        ...github.context.repo,
        commit_sha: github.context.sha,
      })
      .catch(() => defaultResponse);

    return response ?? defaultResponse;
  }
  if (isPullRequestType(github.context.eventName)) {
    const response = await octokit?.rest.issues
      .listComments({
        ...github.context.repo,
        issue_number: github.context.issue.number,
      })
      .catch(() => defaultResponse);

    return response ?? defaultResponse;
  }
  core.error("not supported event_type");
  return defaultResponse;
}

async function findPreviousComment(text: string) {
  core.info("find comment");
  const { data: comments } = await findCommentsForEvent();

  const vercelPreviewURLComment = comments.find((comment) =>
    comment.body?.startsWith(text),
  );
  if (vercelPreviewURLComment) {
    core.info("previous comment found");
    return vercelPreviewURLComment.id;
  }
  core.info("previous comment not found");
  return null;
}

function buildCommentPrefix(name: string) {
  return `Deployment for _${name}_ is ready!`;
}

interface CommentContext {
  name: string;
  commitSha: string;
  previewUrl: string;
  inspectorUrl: string;
}

function buildCommentBody(context: CommentContext) {
  return [
    buildCommentPrefix(context.name),
    "",
    "This pull request has been deployed to Vercel.",
    "",
    "<table>",
    "<tr>",
    "<td><strong>Latest commit:</strong></td>",
    `<td><code>${context.commitSha}</code></td>`,
    "</tr>",
    "<tr>",
    "<td><strong>✅ Preview:</strong></td>",
    `<td><a href='${context.previewUrl}'>${context.previewUrl}</a></td>`,
    "</tr>",
    "<tr>",
    "<td><strong>🔍 Inspect:</strong></td>",
    `<td><a href='${context.inspectorUrl}'>${context.inspectorUrl}</a></td>`,
    "</tr>",
    "</table>",
    "",
    `[View Workflow Logs](${`https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`})`,
  ].join("\n");
}

async function createCommentOnCommit(context: CommentContext) {
  const commentBody = buildCommentBody(context);
  const commentId = await findPreviousComment(buildCommentPrefix(context.name));

  if (commentId) {
    await octokit.rest.repos.updateCommitComment({
      ...github.context.repo,
      comment_id: commentId,
      body: commentBody,
    });
  } else {
    await octokit.rest.repos.createCommitComment({
      ...github.context.repo,
      commit_sha: github.context.sha,
      body: commentBody,
    });
  }
}

async function createCommentOnPullRequest(context: CommentContext) {
  const commentBody = buildCommentBody(context);
  const commentId = await findPreviousComment(buildCommentPrefix(context.name));

  if (commentId) {
    await octokit.rest.issues.updateComment({
      ...github.context.repo,
      comment_id: commentId,
      body: commentBody,
    });
  } else {
    await octokit.rest.issues.createComment({
      ...github.context.repo,
      issue_number: github.context.issue.number,
      body: commentBody,
    });
  }
}

async function run() {
  if (isPullRequestType(github.context.eventName)) {
    const payload = github.context.payload as PullRequestEvent;

    const baseRepo = payload.pull_request.base.repo;
    if (github.context.repo.owner !== baseRepo.owner.login) {
      core.info("Repository is forked, skipping deployment");
      return;
    }
  }

  let { ref, sha } = github.context;
  await setEnv();

  let commitMessage = "";
  if (github.context.eventName === "push") {
    const pushPayload = github.context.payload as PushEvent;
    commitMessage = pushPayload.head_commit?.message ?? "";
  } else if (isPullRequestType(github.context.eventName)) {
    const prPayload = github.context.payload as PullRequestEvent;

    ref = prPayload.pull_request.head.ref;
    sha = prPayload.pull_request.head.sha;

    const { data } = await octokit.rest.git.getCommit({
      ...github.context.repo,
      commit_sha: sha,
    });
    commitMessage = data.message;
  }

  const deploymentUrl = await vercelDeploy(ref, commitMessage);
  if (deploymentUrl) {
    core.info("set preview-url output");
    core.setOutput("preview-url", deploymentUrl);
  } else {
    core.warning("get preview-url error");
  }

  const deploymentName =
    vercel.projectName || (await vercelInspect(deploymentUrl));
  if (deploymentName) {
    core.info("set preview-name output");
    core.setOutput("preview-name", deploymentName);
  } else {
    core.warning("get preview-name error");
  }

  if (deploymentName) {
    if (github.context.issue.number) {
      core.info("this is related issue or pull_request");
      await createCommentOnPullRequest({
        commitSha: sha,
        name: deploymentName,
        previewUrl: deploymentUrl,
        inspectorUrl: `${deploymentUrl}/inspect`,
      });
    } else if (github.context.eventName === "push") {
      core.info("this is push event");
      await createCommentOnCommit({
        commitSha: sha,
        name: deploymentName,
        previewUrl: deploymentUrl,
        inspectorUrl: `${deploymentUrl}/inspect`,
      });
    }
  }
}

(async () => {
  try {
    await run();
  } catch (error: unknown) {
    core.setFailed((error as { message: string }).message);
  }
})();
