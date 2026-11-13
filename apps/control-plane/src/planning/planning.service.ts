import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';

import { validateTaskInputBindings, validateTaskPlan, type CompiledTaskPlan } from '../../../../packages/agent-protocol/src/index.js';
import { CONTROL_PLANE_DATA_SOURCE } from '../registry/registry.service.js';
import { TaskSessionService } from '../tasks/task-session.service.js';
import { TaskWorkspaceService } from '../tasks/task-workspace.service.js';
import { CapabilityCatalogService } from './capability-catalog.service.js';
import { CodexPlannerService, type PlannerOutput, type PlanningTask } from './codex-planner.service.js';
import type { CodexRuntimeStatus } from '../../../../packages/codex-runtime/src/index.js';
import { TaskActivityService } from '../observability/task-activity.service.js';

type StoredTask = PlanningTask & { workspacePath: string; currentPlanVersion: number | null };

/** Compiles the untrusted planner output before anything is scheduled or launched. */
@Injectable()
export class PlanningService {
  public constructor(
    @Inject(CONTROL_PLANE_DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly catalog: CapabilityCatalogService,
    private readonly planner: CodexPlannerService,
    private readonly workspaces: TaskWorkspaceService,
    private readonly sessions: TaskSessionService,
    private readonly activities?: TaskActivityService,
  ) {}

  public async createAndCompile(taskId: string, signal?: AbortSignal): Promise<CompiledTaskPlan> {
    const task = await this.loadTask(taskId);
    const capabilities = await this.catalog.listReady();
    signal?.throwIfAborted();
    if (!task.inputs?.length && isCapabilityQuestion(task.goal)) {
      const lines = capabilities.map((item) => `• ${item.displayName ?? item.capability}${item.description ? '：' + item.description : ''}`);
      const answer = lines.length ? ['当前已审核并就绪的能力有', ...lines].join('\n') : '当前没有已审核并就绪的智能体。管理员可以在智能体管理中查看待审核版本。';
      return this.answer(task, '查询平台能力', answer);
    }
    let failure: Error | undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const planned = await this.planner.plan({
          task,
          capabilities,
          signal,
          workspacePath: task.workspacePath,
          repair: failure ? { reason: publicError(failure) } : undefined,
          onStatus: (status) => this.reportCodexStatus(taskId, status),
        });
        signal?.throwIfAborted();
        validateTaskInputBindings(planned.plan, task.inputs?.map((input) => input.id) ?? []);
        const compiled = validateTaskPlan(planned.plan, capabilities);
        if (compiled.nodes.every((node) => node.type === 'end')) {
          if (task.inputs?.length || planned.deliverables.some((item) => /\.(pptx?|pdf|docx?|xlsx?|zip)\b/i.test(item))) throw new Error('文件交付或附件处理需要实际执行节点。');
          // A model-authored answer is a delivery and must pass the same review gate.
          await this.persistCompiledPlan(task, planned, compiled);
          return compiled;
        }
        await this.persistCompiledPlan(task, planned, compiled);
        return compiled;
      } catch (error) {
        signal?.throwIfAborted();
        failure = asError(error);
        if (attempt === 0) {
          await this.sessions.append(taskId, {
            kind: 'planning_repair_requested',
            message: `规划初稿未通过校验，正在请求 Codex 修复一次：${publicError(failure)}`,
            detail: { attempt: 1 },
          });
        }
      }
    }

    const error = failure ?? new Error('未知规划错误。');
    await this.dataSource.query(`UPDATE tasks SET state='planning_failed', updated_at=now() WHERE id=$1 AND state IN ('received','planning')`, [taskId]);
    await this.sessions.append(taskId, { kind: 'planning_failed', message: `规划失败：${publicError(error)}`, detail: { attempts: 2 } });
    await this.sessions.writeStateSnapshot(taskId, { taskId, state: 'planning_failed', message: publicError(error) });
    throw error;
  }

  private async answer(task: StoredTask, intent: string, summary: string): Promise<CompiledTaskPlan> {
    const state = task.acceptanceMode === 'human_review' ? 'awaiting_review' : 'accepted';
    const result = { mode: 'direct_answer', intent, summary };
    const [, count] = await this.dataSource.query(`UPDATE tasks SET state=$2, planner_summary=$3::jsonb, updated_at=now() WHERE id=$1 AND state IN ('received','planning')`, [task.id, state, JSON.stringify(result)]);
    if (count === 1) {
      await this.sessions.append(task.id, { kind: 'direct_answer', message: summary });
      await this.sessions.writeStateSnapshot(task.id, { taskId: task.id, state, ...result });
      await this.activities?.append({ taskId: task.id, kind: 'direct_answer', state, message: '中台已直接答复。', source: 'control_plane' });
    }
    return { version: 'v1', nodes: [{ id: 'finish', type: 'end' }] };
  }

  private async reportCodexStatus(taskId: string, status: CodexRuntimeStatus): Promise<void> {
    await this.activities?.append({
      taskId,
      kind: 'planning_codex_status',
      state: 'planning',
      message: plannerStatusMessage(status),
      detail: { runtime: 'codex', phase: 'planning', ...status },
      source: 'control_plane',
    });
  }

  private async loadTask(taskId: string): Promise<StoredTask> {
    const rows = await this.dataSource.query<StoredTask[]>(`
      SELECT id, goal, acceptance_mode AS "acceptanceMode", workspace_path AS "workspacePath", current_plan_version AS "currentPlanVersion"
      FROM tasks WHERE id=$1
    `, [taskId]);
    if (!rows[0]) throw new NotFoundException('Task not found.');
    const inputs = await this.dataSource.query<Array<{ id: string; displayName: string; sourceType: string; mediaType: string; sizeBytes: number | string; sha256: string }>>(`
      SELECT id, display_name AS "displayName", source_type AS "sourceType", media_type AS "mediaType", size_bytes AS "sizeBytes", sha256
      FROM task_inputs WHERE task_id=$1 ORDER BY created_at, id
    `, [taskId]);
    return { ...rows[0], inputs: inputs.map((input) => ({ ...input, sizeBytes: Number(input.sizeBytes) })) };
  }

  private async persistCompiledPlan(task: StoredTask, planned: PlannerOutput, compiled: CompiledTaskPlan): Promise<void> {
    const version = (task.currentPlanVersion ?? 0) + 1;
    const rawPath = await this.workspaces.resolveTaskPath(task.id, join('plans', `plan-v${version}.json`));
    const compiledPath = await this.workspaces.resolveTaskPath(task.id, join('plans', `compiled-plan-v${version}.json`));
    const summary = { ...(compiled.nodes.every(n=>n.type==='end') ? {mode:'direct_answer'} : {}), intent: planned.intent, summary: planned.summary, deliverables: planned.deliverables, assumptions: planned.assumptions, risks: planned.risks };
    const persisted = { ...compiled, nodeReasons: planned.nodeReasons, planner: summary };

    await writeFile(rawPath, `${JSON.stringify(planned, null, 2)}\n`, 'utf8');
    await writeFile(compiledPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
    const saved = await this.dataSource.transaction(async (manager) => {
      const [, count] = await manager.query(`UPDATE tasks SET state='planned', planner_summary=$2::jsonb, current_plan_version=$3, updated_at=now() WHERE id=$1 AND state IN ('received','planning')`, [task.id, JSON.stringify(summary), version]);
      if (!count) return false;
      await manager.query(`INSERT INTO task_plans (id, task_id, version, plan, state) VALUES ($1,$2,$3,$4::jsonb,'compiled')`, [randomUUID(), task.id, version, JSON.stringify(persisted)]);
      return true;
    });
    if (!saved) return;
    await this.sessions.append(task.id, {
      kind: 'planning_completed',
      message: `规划完成：${planned.summary}`,
      detail: { intent: planned.intent, nodeCount: compiled.nodes.length, deliverables: planned.deliverables },
    });
    await this.sessions.writeStateSnapshot(task.id, { taskId: task.id, state: 'planned', planVersion: version, summary: planned.summary });
  }
}

// Only whole, unambiguous catalog questions can bypass semantic planning.
export function isCapabilityQuestion(goal: string): boolean {
  const query = goal.normalize('NFKC').trim().replace(/[?!.。！？，,\s]+$/u, '').replace(/^(?:你好[,， ]*|请问[,， ]*|请介绍一下|请介绍)+/u, '').trim();
  return /^(?:你们?|您|这个平台|平台|系统|中台)?(?:都|现在|目前)?(?:能|可以|能够)(?:帮(?:助)?我)?(?:做|干)(?:哪些事(?:情)?|什么(?:事(?:情)?)?)$/u.test(query)
    || /^(?:你们?|您|这个平台|平台|系统|中台)?(?:目前|现在)?(?:都)?(?:有|支持|提供|具备)(?:什么|哪些)(?:功能|能力|服务|智能体)$/u.test(query)
    || /^(?:what can you (?:do|help me with)|(?:list|show) (?:your |available )?capabilities)$/i.test(query);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('未知规划错误。');
}

/** Keep repair and console messages factual, bounded and free of private model output. */
function publicError(error: Error): string {
  return error.message.replace(/\s+/g, ' ').slice(0, 1_000);
}

function plannerStatusMessage(status: CodexRuntimeStatus): string {
  const details: string[] = [];
  details.push(`已运行 ${humanDuration(status.elapsedMs)}`);
  if (status.lastOutputAgeMs !== undefined) details.push(`最近输出 ${humanDuration(status.lastOutputAgeMs)}前`);
  else if (!status.outputReceived) details.push('尚未收到输出');
  return `Codex 正在进行中台意图分析，${details.join('，')}。`;
}

function humanDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
  return `${Math.floor(minutes / 60)}时${minutes % 60}分`;
}
