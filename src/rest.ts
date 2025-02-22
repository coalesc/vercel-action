import * as core from "@actions/core";
import * as github from "@actions/github";

interface Comment {
  id: number;
  body?: string;
}

interface CommentContext {
  body?: string;
  name?: string;
  commitSha?: string;
  inspectUrl?: string;
  deploymentUrl?: string;
}

const deploymentOptions = {
  owner: github.context.repo.owner,
  repo: github.context.repo.repo,
  environment: core.getInput("environment", { required: true }),
};

export class Rest {
  octokit = github.getOctokit(
    core.getInput("github-token", { required: true }),
  );

  private get logUrl() {
    return `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`;
  }

  isPullRequestType(event: string) {
    return event.startsWith("pull_request");
  }

  async createComment(context: CommentContext) {
    if (github.context.issue.number)
      await this.createCommentOnPullRequest(context);
    else if (github.context.eventName === "push")
      await this.createCommentOnCommit(context);
  }

  async checkCollaborator() {
    return this.octokit.rest.repos
      .checkCollaborator({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        username: github.context.actor,
      })
      .then(() => true)
      .catch(() => false);
  }

  async createDeployment(ref: string) {
    return this.octokit.rest.repos.createDeployment({
      ...deploymentOptions,
      ref,
      required_contexts: [],
    });
  }

  async updateDeployment(
    id: number,
    state: NonNullable<
      Parameters<
        (typeof this)["octokit"]["rest"]["repos"]["createDeploymentStatus"]
      >[0]
    >["state"],
    urls?: Pick<CommentContext, "deploymentUrl" | "inspectUrl">,
  ) {
    return this.octokit.rest.repos.createDeploymentStatus({
      ...deploymentOptions,
      deployment_id: id,
      state,
      environment_url: urls?.deploymentUrl,
      log_url: urls?.inspectUrl ?? this.logUrl,
    });
  }

  private async createCommentOnCommit(context: CommentContext) {
    const commentBody = this.buildCommentBody(context);
    const commentId = await this.findPreviousComment(this.buildCommentPrefix());

    if (commentId) {
      await this.octokit.rest.repos.updateCommitComment({
        ...github.context.repo,
        comment_id: commentId,
        body: commentBody,
      });
    } else {
      await this.octokit.rest.repos.createCommitComment({
        ...github.context.repo,
        commit_sha: github.context.sha,
        body: commentBody,
      });
    }
  }

  private async createCommentOnPullRequest(context: CommentContext) {
    const commentBody = this.buildCommentBody(context);
    const commentId = await this.findPreviousComment(this.buildCommentPrefix());

    if (commentId) {
      await this.octokit.rest.issues.updateComment({
        ...github.context.repo,
        comment_id: commentId,
        body: commentBody,
      });
    } else {
      await this.octokit.rest.issues.createComment({
        ...github.context.repo,
        issue_number: github.context.issue.number,
        body: commentBody,
      });
    }
  }

  private buildCommentPrefix() {
    return "<!-- VERCEL DEPLOYMENT COMMENT -->";
  }

  private buildCommentBody(context: CommentContext) {
    return [
      this.buildCommentPrefix(),
      "",
      context.body ?? [
        "<table>",
        "<tr>",
        "<td><strong>Latest commit:</strong></td>",
        `<td>${context.commitSha}</td>`,
        "</tr>",
        "<tr>",
        "<td><strong>Name:</strong></td>",
        `<td>${context.name ?? "N/A"}</td>`,
        "</tr>",
        "<tr>",
        "<td><strong>⏰ Status:</strong></td>",
        `<td>${!context.inspectUrl ? "Pending" : "Ready"}</td>`,
        "</tr>",
        "<tr>",
        "<td><strong>✅ Deployment:</strong></td>",
        `<td>${!context.inspectUrl ? "N/A" : `<a href='${context.deploymentUrl}'>${context.deploymentUrl}</a>`}</td>`,
        "</tr>",
        "<tr>",
        "<td><strong>🔍 Inspect:</strong></td>",
        `<td>${!context.inspectUrl ? "N/A" : `<a href='${context.inspectUrl}'>Visit Vercel dashboard</a>`}</td>`,
        "</tr>",
        "<tr>",
        "<td><strong>📝 Workflow Logs:</strong></td>",
        `<td><a href='${this.logUrl}'>View logs</a></td>`,
        "</tr>",
        "</table>",
      ],
    ]
      .flat()
      .join("\n");
  }

  private async findCommentsForEvent(): Promise<{ data: Comment[] }> {
    const defaultResponse = {
      data: [] as Comment[],
    };

    if (github.context.eventName === "push") {
      const response = await this.octokit?.rest.repos
        .listCommentsForCommit({
          ...github.context.repo,
          commit_sha: github.context.sha,
        })
        .catch(() => defaultResponse);

      return response ?? defaultResponse;
    }
    if (this.isPullRequestType(github.context.eventName)) {
      const response = await this.octokit?.rest.issues
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

  private async findPreviousComment(text: string) {
    const { data: comments } = await this.findCommentsForEvent();
    return comments.find((comment) => comment.body?.startsWith(text))?.id;
  }
}
