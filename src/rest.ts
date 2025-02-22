import * as core from "@actions/core";
import * as github from "@actions/github";

interface Comment {
  id: number;
  body?: string;
}

interface CommentContext {
  name: string;
  commitSha: string;
  inspectUrl: string;
  deploymentUrl: string;
}

export class Rest {
  octokit = github.getOctokit(
    core.getInput("github-token", { required: true }),
  );

  isPullRequestType(event: string) {
    return event.startsWith("pull_request");
  }

  async createCommentOnCommit(context: CommentContext) {
    const commentBody = this.buildCommentBody(context);
    const commentId = await this.findPreviousComment(
      this.buildCommentPrefix(context.name),
    );

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

  async createCommentOnPullRequest(context: CommentContext) {
    const commentBody = this.buildCommentBody(context);
    const commentId = await this.findPreviousComment(
      this.buildCommentPrefix(context.name),
    );

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

  private buildCommentPrefix(name: string) {
    return "<!-- VERCEL DEPLOYMENT COMMENT -->";
  }

  private buildCommentBody(context: CommentContext) {
    return [
      this.buildCommentPrefix(context.name),
      "",
      "<table>",
      "<tr>",
      "<td><strong>Name:</strong></td>",
      `<td>${context.name}</td>`,
      "</tr>",
      "<tr>",
      "<td><strong>Latest commit:</strong></td>",
      `<td>${context.commitSha}</td>`,
      "</tr>",
      "<tr>",
      "<td><strong>⏰ Status:</strong></td>",
      "<td>Ready</td>",
      "</tr>",
      "<tr>",
      "<td><strong>🔍 Inspect:</strong></td>",
      `<td><a href='${context.inspectUrl}'>${context.inspectUrl}</a></td>`,
      "</tr>",
      "<tr>",
      "<td><strong>✅ Deployment:</strong></td>",
      `<td><a href='${context.deploymentUrl}'>${context.deploymentUrl}</a></td>`,
      "</tr>",
      "<tr>",
      "<td><strong>📝 Workflow Logs:</strong></td>",
      `<td><a href='https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}'>View logs</a></td>`,
      "</tr>",
      "</table>",
    ].join("\n");
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
