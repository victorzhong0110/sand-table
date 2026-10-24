// 代码包的三个工具：code_repo、code_change 给模型，code_decide 只给界面。
//
// 批准不在 code_change 里。code_decide 再核对一次调用者，agent 会被拒绝。

import { z } from "zod";
import { CommandError, type ToolRegistrar } from "../../kernel/index.ts";
import {
  createIntent,
  decideProposal,
  prepareApply,
  publishProposal,
  readApprovedFile,
  readIntents,
  readProposal,
  readTarget,
  reportValidation,
  verifyProposal,
} from "./changes.ts";
import {
  importRepository,
  readIndexedSource,
  refreshRepositories,
} from "./sync.ts";

const id = z.string().min(1).max(500);
const fileRef = z.object({
  workspaceId: id,
  path: z.string().min(1).max(500),
});

export function registerCodeTools(registrar: ToolRegistrar): void {
  registrar.tool(
    "code_repo",
    "Import a local Git root, refresh its index, or read a source excerpt. Does not clone, install, execute, or write files.",
    {
      action: z.enum(["import", "refresh", "read_source"]),
      path: z.string().min(1).max(2000).optional(),
      workspaceId: id.optional(),
      objectId: z.string().min(1).max(2000).optional(),
      startLine: z.number().int().positive().optional(),
      maxLines: z.number().int().min(1).max(120).optional(),
    },
    (args, ctx) => {
      if (args.action === "import")
        return importRepository(ctx.db, ctx.registry, ctx.actor, {
          ...(args.path ? { path: args.path } : {}),
          ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
        });
      if (args.action === "refresh")
        return refreshRepositories(
          ctx.db,
          ctx.registry,
          ctx.actor,
          args.workspaceId,
        );
      if (!args.objectId)
        throw new CommandError(
          "INVALID_DATA",
          "读取源码要给出对象编号。请先查询 code.file 或 code.symbol。",
          null,
        );
      return readIndexedSource(ctx.db, args.objectId, {
        ...(args.startLine ? { startLine: args.startLine } : {}),
        ...(args.maxLines ? { maxLines: args.maxLines } : {}),
      });
    },
  );

  registrar.tool(
    "code_change",
    "Create a change intent, publish an exact proposal, and check the worktree before the host writes. Does not approve proposals and does not write files.",
    {
      action: z.enum([
        "create_intent",
        "read_intents",
        "read_target",
        "publish_proposal",
        "read_proposal",
        "prepare_apply",
        "read_approved_file",
        "verify",
        "report_validation",
      ]),
      boardId: id.optional(),
      revision: z.number().int().nonnegative().optional(),
      request: z.string().min(1).max(4000).optional(),
      objectIds: z.array(id).max(1200).optional(),
      allowedFiles: z.array(fileRef).max(12).optional(),
      intentId: id.optional(),
      viewId: id.optional(),
      intentVersion: z.number().int().positive().optional(),
      proposalId: id.optional(),
      previousVersion: z.number().int().positive().optional(),
      agentId: id.optional(),
      title: z.string().min(1).max(120).optional(),
      explanation: z.string().min(1).max(4000).optional(),
      testPlan: z.string().min(1).max(2000).optional(),
      files: z
        .array(
          fileRef.extend({
            beforeHash: z.string().nullable(),
            after: z.string().max(200000).nullable(),
          }),
        )
        .max(12)
        .optional(),
      workspaceId: id.optional(),
      path: z.string().min(1).max(500).optional(),
      startLine: z.number().int().positive().optional(),
      version: z.number().int().positive().optional(),
      digest: z.string().min(1).max(200).optional(),
      fileIndex: z.number().int().nonnegative().optional(),
      command: z.string().min(1).max(1000).optional(),
      environment: z.string().min(1).max(1000).optional(),
      outcome: z.enum(["passed", "failed", "not-run"]).optional(),
      output: z.string().max(8000).optional(),
    },
    (args, ctx) => {
      const actor = ctx.actor;
      if (args.action === "create_intent") {
        if (
          !args.boardId ||
          args.revision === undefined ||
          !args.request ||
          !args.allowedFiles
        )
          throw new CommandError(
            "INVALID_DATA",
            "创建意图需要白板、修订号、改动请求，以及允许修改的文件。请补全后再提交。",
            null,
          );
        return createIntent(ctx.db, ctx.registry, actor, {
          boardId: args.boardId,
          revision: args.revision,
          request: args.request,
          ...(args.objectIds ? { objectIds: args.objectIds } : {}),
          allowedFiles: args.allowedFiles,
          ...(args.intentId ? { intentId: args.intentId } : {}),
          ...(args.viewId ? { viewId: args.viewId } : {}),
        });
      }
      if (args.action === "read_intents") return readIntents(ctx.db);
      if (args.action === "read_target") {
        if (!args.intentId || !args.workspaceId || !args.path)
          throw new CommandError(
            "INVALID_DATA",
            "读取目标文件需要意图编号、仓库编号和路径。请补全后再读。",
            null,
          );
        return readTarget(ctx.db, {
          intentId: args.intentId,
          workspaceId: args.workspaceId,
          path: args.path,
          ...(args.startLine ? { startLine: args.startLine } : {}),
        });
      }
      if (args.action === "publish_proposal") {
        if (
          !args.intentId ||
          args.intentVersion === undefined ||
          !args.agentId ||
          !args.title ||
          !args.explanation ||
          !args.testPlan ||
          !args.files?.length
        )
          throw new CommandError(
            "INVALID_DATA",
            "发布提案需要意图、意图版本、提交者、标题、说明、验证计划和文件。请补全后再提交。",
            null,
          );
        return publishProposal(ctx.db, ctx.registry, actor, {
          intentId: args.intentId,
          intentVersion: args.intentVersion,
          ...(args.proposalId ? { proposalId: args.proposalId } : {}),
          ...(args.previousVersion !== undefined
            ? { previousVersion: args.previousVersion }
            : {}),
          agentId: args.agentId,
          title: args.title,
          explanation: args.explanation,
          testPlan: args.testPlan,
          files: args.files,
        });
      }
      if (args.action === "read_proposal") {
        if (!args.proposalId)
          throw new CommandError(
            "INVALID_DATA",
            "读取提案需要提案编号。请先发布，或从意图里找到提案。",
            null,
          );
        return readProposal(ctx.db, args.proposalId);
      }
      if (
        args.action === "prepare_apply" ||
        args.action === "read_approved_file"
      ) {
        if (!args.proposalId || args.version === undefined || !args.digest)
          throw new CommandError(
            "INVALID_DATA",
            "这一步需要提案编号、内容版本和摘要。请重新读取提案后再继续。",
            null,
          );
        if (args.action === "prepare_apply")
          return prepareApply(ctx.db, ctx.registry, actor, {
            proposalId: args.proposalId,
            version: args.version,
            digest: args.digest,
          });
        if (args.fileIndex === undefined)
          throw new CommandError(
            "INVALID_DATA",
            "读取已批准文件需要文件序号。请从 0 开始按提案里的顺序读取。",
            null,
          );
        return readApprovedFile(ctx.db, ctx.registry, actor, {
          proposalId: args.proposalId,
          version: args.version,
          digest: args.digest,
          fileIndex: args.fileIndex,
        });
      }
      if (args.action === "verify") {
        if (!args.proposalId)
          throw new CommandError(
            "INVALID_DATA",
            "核对需要提案编号。请先发布提案。",
            null,
          );
        return verifyProposal(ctx.db, ctx.registry, actor, args.proposalId);
      }
      if (
        !args.proposalId ||
        args.version === undefined ||
        !args.digest ||
        !args.agentId ||
        !args.workspaceId ||
        !args.command ||
        !args.environment ||
        !args.outcome ||
        args.output === undefined
      )
        throw new CommandError(
          "INVALID_DATA",
          "报告验证结果需要提案编号、版本、摘要、提交者、仓库、命令、环境和输出。请补全后再提交。",
          null,
        );
      return reportValidation(ctx.db, ctx.registry, actor, {
        proposalId: args.proposalId,
        version: args.version,
        digest: args.digest,
        agentId: args.agentId,
        workspaceId: args.workspaceId,
        command: args.command,
        environment: args.environment,
        outcome: args.outcome,
        output: args.output,
      });
    },
  );

  registrar.tool(
    "code_decide",
    "Human approves or rejects the current proposal digest. Agents cannot use this tool.",
    {
      proposalId: id,
      decision: z.enum(["approve", "reject"]),
      digest: z.string().min(1).max(200),
    },
    (args, ctx) =>
      decideProposal(ctx.db, ctx.registry, ctx.actor, {
        proposalId: args.proposalId,
        decision: args.decision,
        digest: args.digest,
      }),
    { appOnly: true },
  );
}

export { decideProposal };
