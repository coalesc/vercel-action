import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import { stripIndents } from "common-tags";
import packageJSON from "./package.json" assert { type: "json" };

const { context } = github;

const githubToken = core.getInput("github-token");
const workingDirectory = core.getInput("working-directory");

function isPullRequestType(event: string) {
  return event.startsWith("pull_request");
}

// Vercel
function getVercelBin() {
  const input = core.getInput("vercel-version");
  const fallback = packageJSON.dependencies.vercel;
  return `vercel@${input || fallback}`;
}

const vercelToken = core.getInput("vercel-token", { required: true });
const vercelArgs = core.getInput("vercel-args");
const vercelOrgId = core.getInput("vercel-org-id", { required: true });
const vercelProjectId = core.getInput("vercel-project-id", { required: true });
const vercelScope = core.getInput("scope");
const vercelProjectName = core.getInput("vercel-project-name");
const vercelBin = getVercelBin();

const octokit = githubToken ? github.getOctokit(githubToken) : undefined;

async function setEnv() {
  core.info("set environment for vercel cli");
  if (vercelOrgId) {
    core.info("set env variable : VERCEL_ORG_ID");
    core.exportVariable("VERCEL_ORG_ID", vercelOrgId);
  }
  if (vercelProjectId) {
    core.info("set env variable : VERCEL_PROJECT_ID");
    core.exportVariable("VERCEL_PROJECT_ID", vercelProjectId);
  }
}

function addVercelMetadata(
  key: string,
  value: string | number,
  providedArgs: string[],
) {
  // returns a list for the metadata commands if key was not supplied by user in action parameters
  // returns an empty list if key was provided by user
  const pattern = `^${key}=.+`;
  const metadataRegex = new RegExp(pattern, "g");
  // eslint-disable-next-line no-restricted-syntax
  for (const arg of providedArgs) {
    if (arg.match(metadataRegex)) {
      return [];
    }
  }

  return ["-m", `${key}=${value}`];
}

/**
 *
 * The following regex is used to split the vercelArgs string into an array of arguments.
 * It conserves strings wrapped in simple / double quotes, with nested different quotes, as a single argument.
 *
 * Example:
 *
 * parseArgs(`--env foo=bar "foo=bar baz" 'foo="bar baz"'`) => ['--env', 'foo=bar', 'foo=bar baz', 'foo="bar baz"']
 */
function parseArgs(s: string) {
  const args = [];

  for (const match of s.matchAll(/'([^']*)'|"([^"]*)"|[^\s]+/gm)) {
    args.push(match[1] ?? match[2] ?? match[0]);
  }
  return args;
}

async function vercelDeploy(ref: string, commit: string) {
  let output = "";
  const options: exec.ExecOptions = {
    listeners: {
      stdout: (data) => {
        output += data.toString();
        core.info(data.toString());
      },
    },
  };
  if (workingDirectory) {
    options.cwd = workingDirectory;
  }

  const providedArgs = parseArgs(vercelArgs);

  const args = [
    ...providedArgs,
    ...["-t", vercelToken],
    ...addVercelMetadata("githubCommitSha", context.sha, providedArgs),
    ...addVercelMetadata("githubCommitAuthorName", context.actor, providedArgs),
    ...addVercelMetadata(
      "githubCommitAuthorLogin",
      context.actor,
      providedArgs,
    ),
    ...addVercelMetadata("githubDeployment", 1, providedArgs),
    ...addVercelMetadata("githubOrg", context.repo.owner, providedArgs),
    ...addVercelMetadata("githubRepo", context.repo.repo, providedArgs),
    ...addVercelMetadata("githubCommitOrg", context.repo.owner, providedArgs),
    ...addVercelMetadata("githubCommitRepo", context.repo.repo, providedArgs),
    ...addVercelMetadata("githubCommitMessage", `"${commit}"`, providedArgs),
    ...addVercelMetadata(
      "githubCommitRef",
      ref.replace("refs/heads/", ""),
      providedArgs,
    ),
  ];

  if (vercelScope) {
    core.info("using scope");
    args.push("--scope", vercelScope);
  }

  await exec.exec("npx", [vercelBin, ...args], options);
  return output;
}

async function vercelInspect(deploymentUrl: string) {
  let error = "";
  const options: exec.ExecOptions = {
    listeners: {
      stderr: (data) => {
        error += data.toString();
        core.info(data.toString());
      },
    },
  };
  if (workingDirectory) {
    options.cwd = workingDirectory;
  }

  const args = [vercelBin, "inspect", deploymentUrl, "-t", vercelToken];

  if (vercelScope) {
    core.info("using scope");
    args.push("--scope", vercelScope);
  }
  await exec.exec("npx", args, options);

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

  core.debug("find comments for event");
  if (context.eventName === "push") {
    core.debug('event is "commit", use "listCommentsForCommit"');
    const response = await octokit?.rest.repos
      .listCommentsForCommit({
        ...context.repo,
        commit_sha: context.sha,
      })
      .catch(() => defaultResponse);

    return response ?? defaultResponse;
  }
  if (isPullRequestType(context.eventName)) {
    core.debug(`event is "${context.eventName}", use "listComments"`);
    const response = await octokit?.rest.issues
      .listComments({
        ...context.repo,
        issue_number: context.issue.number,
      })
      .catch(() => defaultResponse);

    return response ?? defaultResponse;
  }
  core.error("not supported event_type");
  return defaultResponse;
}

async function findPreviousComment(text: string) {
  if (!octokit) {
    return null;
  }
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

function buildCommentPrefix(deploymentName: string) {
  return `Deploy preview for _${deploymentName}_ ready!`;
}

function buildCommentBody(
  deploymentCommit: string,
  deploymentUrl: string,
  deploymentName: string,
) {
  const prefix = `${buildCommentPrefix(deploymentName)}\n\n`;

  const rawGithubComment =
    prefix +
    stripIndents`
      ✅ Preview
      {{deploymentUrl}}
      
      Built with commit {{deploymentCommit}}.
      This pull request is being automatically deployed with [vercel-action](https://github.com/marketplace/actions/vercel-action)
    `;

  return rawGithubComment
    .replace(/\{\{deploymentCommit\}\}/g, deploymentCommit)
    .replace(/\{\{deploymentName\}\}/g, deploymentName)
    .replace(/\{\{deploymentUrl\}\}/g, deploymentUrl);
}

async function createCommentOnCommit(
  deploymentCommit: string,
  deploymentUrl: string,
  deploymentName: string,
) {
  if (!octokit) {
    return;
  }
  const commentId = await findPreviousComment(
    buildCommentPrefix(deploymentName),
  );

  const commentBody = buildCommentBody(
    deploymentCommit,
    deploymentUrl,
    deploymentName,
  );

  if (commentId) {
    await octokit.rest.repos.updateCommitComment({
      ...context.repo,
      comment_id: commentId,
      body: commentBody,
    });
  } else {
    await octokit.rest.repos.createCommitComment({
      ...context.repo,
      commit_sha: context.sha,
      body: commentBody,
    });
  }
}

async function createCommentOnPullRequest(
  deploymentCommit: string,
  deploymentUrl: string,
  deploymentName: string,
) {
  if (!octokit) {
    return;
  }
  const commentId = await findPreviousComment(
    `Deploy preview for _${deploymentName}_ ready!`,
  );

  const commentBody = buildCommentBody(
    deploymentCommit,
    deploymentUrl,
    deploymentName,
  );

  if (commentId) {
    await octokit.rest.issues.updateComment({
      ...context.repo,
      comment_id: commentId,
      body: commentBody,
    });
  } else {
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: context.issue.number,
      body: commentBody,
    });
  }
}

async function run() {
  core.debug(`action : ${context.action}`);
  core.debug(`ref : ${context.ref}`);
  core.debug(`eventName : ${context.eventName}`);
  core.debug(`actor : ${context.actor}`);
  core.debug(`sha : ${context.sha}`);
  core.debug(`workflow : ${context.workflow}`);
  let { ref, sha } = context;
  await setEnv();

  let commit = "";
  exec.exec("git", ["log", "-1", "--pretty=format:%B"], {
    listeners: {
      stdout: (data) => {
        commit += data.toString();
      },
    },
  });
  commit = commit.trim();

  if (github.context.eventName === "push") {
    const pushPayload = github.context.payload;
    core.debug(`The head commit is: ${pushPayload.head_commit}`);
  } else if (isPullRequestType(github.context.eventName)) {
    const pullRequestPayload = github.context.payload;
    const pr =
      pullRequestPayload.pull_request || pullRequestPayload.pull_request_target;
    core.debug(`head : ${pr.head}`);

    ref = pr.head.ref;
    sha = pr.head.sha;
    core.debug(`The head ref is: ${pr.head.ref}`);
    core.debug(`The head sha is: ${pr.head.sha}`);

    if (octokit) {
      const { data: commitData } = await octokit.rest.git.getCommit({
        ...context.repo,
        commit_sha: sha,
      });
      commit = commitData.message;
      core.debug(`The head commit is: ${commit}`);
    }
  }

  const deploymentUrl = await vercelDeploy(ref, commit);

  if (deploymentUrl) {
    core.info("set preview-url output");
    core.setOutput("preview-url", deploymentUrl);
  } else {
    core.warning("get preview-url error");
  }

  const deploymentName =
    vercelProjectName || (await vercelInspect(deploymentUrl));
  if (deploymentName) {
    core.info("set preview-name output");
    core.setOutput("preview-name", deploymentName);
  } else {
    core.warning("get preview-name error");
  }

  if (githubToken && deploymentName) {
    if (context.issue.number) {
      core.info("this is related issue or pull_request");
      await createCommentOnPullRequest(sha, deploymentUrl, deploymentName);
    } else if (context.eventName === "push") {
      core.info("this is push event");
      await createCommentOnCommit(sha, deploymentUrl, deploymentName);
    }
  } else {
    core.info("comment : disabled");
  }
}

(async () => {
  try {
    await run();
  } catch (error: unknown) {
    core.setFailed((error as { message: string }).message);
  }
})();
