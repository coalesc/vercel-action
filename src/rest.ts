import * as core from "@actions/core";
import * as github from "@actions/github";

interface Comment {
  id: number;
  body?: string;
}

interface CommentContext {
  name: string;
  commitSha: string;
  previewUrl: string;
  inspectorUrl: string;
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
    return `Deployment for _${name}_ is ready!`;
  }

  private buildCommentBody(context: CommentContext) {
    return [
      this.buildCommentPrefix(context.name),
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
    core.info("find comment");
    const { data: comments } = await this.findCommentsForEvent();

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
}
