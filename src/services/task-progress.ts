import type { SessionPersistenceService } from './session-persistence.js'
import type { TaskSpecification } from './task-specification.js'

/** 一个规划任务的执行状态。 */
export type TaskProgressStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'

/** 一项任务的当前进度。 */
export interface TaskProgress {
  /** 对应 TaskSpecification.tasks 中的稳定 id。 */
  readonly taskId: string
  /** 当前执行状态。 */
  readonly status: TaskProgressStatus
  /** Worker 对当前状态的简短说明。 */
  readonly summary?: string
}

/** 任务进度服务。 */
export interface TaskProgressService {
  /** 将进度绑定到一份任务规格，并恢复已有状态。 */
  initialize(specification: TaskSpecification): void

  /** 返回当前任务进度。 */
  current(): readonly TaskProgress[]

  /** 更新一项任务的状态。 */
  update(taskId: string, status: TaskProgressStatus, summary?: string): void

  /** 返回注入 Worker system prompt 的 JSON 文本。 */
  promptContext(): string
}

/** 内存实现，持久化 Provider 存在时同步追加进度记录。 */
export class DefaultTaskProgressService implements TaskProgressService {
  private specification: TaskSpecification | undefined
  private progress = new Map<string, TaskProgress>()

  /**
   * @param persistence - 可选的 JSONL 进度持久化 Provider。
   */
  constructor(private readonly persistence?: SessionPersistenceService) {}

  /** 将进度绑定到新的任务规格。 */
  initialize(specification: TaskSpecification): void {
    const previous = this.progress
    const persisted = this.persistence?.taskProgress() ?? []
    const persistedByTask = new Map(persisted.map((item) => [item.taskId, item]))
    const persistedSpecification = this.persistence?.taskSpecification()
    const sameSpecification =
      this.specification === undefined
        ? persistedSpecification === undefined ||
          specificationsEqual(persistedSpecification, specification)
        : specificationsEqual(this.specification, specification)

    this.specification = specification
    this.progress = new Map(specification.tasks.map((task) => {
      const existing = sameSpecification
        ? previous.get(task.id) ?? persistedByTask.get(task.id)
        : undefined
      return [
        task.id,
        existing === undefined
          ? { taskId: task.id, status: 'pending' as const }
          : cloneProgress(existing),
      ]
    }))
  }

  /** 返回当前任务进度的副本。 */
  current(): readonly TaskProgress[] {
    return [...this.progress.values()].map(cloneProgress)
  }

  /** 更新并持久化一项任务的状态。 */
  update(taskId: string, status: TaskProgressStatus, summary?: string): void {
    if (this.specification === undefined) {
      throw new Error('task progress is not initialized')
    }
    if (!this.progress.has(taskId)) {
      throw new Error(`unknown task id "${taskId}"`)
    }

    const normalizedSummary = summary?.trim()
    const next: TaskProgress = {
      taskId,
      status,
      ...(normalizedSummary === undefined || normalizedSummary.length === 0
        ? {}
        : { summary: normalizedSummary }),
    }
    this.persistence?.saveTaskProgress(next)
    this.progress.set(taskId, next)
  }

  /** 返回稳定的 JSON 进度摘要。 */
  promptContext(): string {
    return JSON.stringify(this.current())
  }
}

/** 校验并复制来自模型或持久化层的任务进度。 */
export function validateTaskProgress(value: unknown): TaskProgress {
  if (!isRecord(value)) {
    throw new Error('TaskProgress must be a JSON object')
  }
  if (typeof value.taskId !== 'string' || value.taskId.trim().length === 0) {
    throw new Error('TaskProgress taskId must be a non-empty string')
  }
  if (
    value.status !== 'pending' &&
    value.status !== 'in_progress' &&
    value.status !== 'completed' &&
    value.status !== 'blocked'
  ) {
    throw new Error('TaskProgress status is invalid')
  }
  if (value.summary !== undefined && typeof value.summary !== 'string') {
    throw new Error('TaskProgress summary must be a string')
  }

  const summary = typeof value.summary === 'string'
    ? value.summary.trim()
    : ''
  return {
    taskId: value.taskId.trim(),
    status: value.status,
    ...(summary.length === 0 ? {} : { summary }),
  }
}

/** 复制任务进度，避免调用方修改内部状态。 */
function cloneProgress(progress: TaskProgress): TaskProgress {
  return {
    taskId: progress.taskId,
    status: progress.status,
    ...(progress.summary === undefined ? {} : { summary: progress.summary }),
  }
}

/** 判断两份已校验的规格是否描述同一个任务。 */
function specificationsEqual(
  left: TaskSpecification,
  right: TaskSpecification,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** 判断普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
