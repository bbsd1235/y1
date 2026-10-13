import type { TaskProgress } from './task-progress.js'

/**
 * Planner 交给 Working Agent 的结构化任务规格。
 *
 * 该类型只描述目标、边界和验收标准，不描述具体文件、命令或技术实现。
 */
export interface TaskSpecification {
  /** 任务要达成的总体目标。 */
  readonly goal: string

  /** 用户期望得到的交付物。 */
  readonly deliverables: readonly string[]

  /** Planner 划分出的可验证任务目标。 */
  readonly tasks: readonly PlannedTask[]

  /** Worker 必须遵守的约束。 */
  readonly constraints: readonly string[]

  /** 判断任务是否完成的标准。 */
  readonly acceptanceCriteria: readonly string[]

  /** 明确不属于本次任务的内容。 */
  readonly outOfScope: readonly string[]
}

/**
 * 任务规格的存取服务。
 *
 * 规格是 Planning Agent 与 Working Agent 之间的当前任务状态；持久化
 * Provider 存在时，save() 同时把它追加到 Session 日志。
 */
export interface TaskSpecificationService {
  /** 返回当前任务规格；尚未规划时返回 undefined。 */
  current(): TaskSpecification | undefined

  /** 保存当前任务规格。 */
  save(specification: TaskSpecification): void
}

/** Specification 中的一项任务目标。 */
export interface PlannedTask {
  /** 稳定的任务标识。 */
  readonly id: string

  /** 任务要完成什么，不描述具体实现方式。 */
  readonly objective: string
}

/**
 * 校验并复制未知值为合法的 TaskSpecification。
 *
 * @param value - JSON.parse 得到的未知值。
 * @returns 校验后的任务规格。
 */
export function validateTaskSpecification(
  value: unknown,
): TaskSpecification {
  if (!isRecord(value)) {
    throw new Error('TaskSpecification must be a JSON object')
  }

  const expectedKeys = new Set([
    'goal',
    'deliverables',
    'tasks',
    'constraints',
    'acceptanceCriteria',
    'outOfScope',
  ])

  const unknownKeys = Object.keys(value).filter(
    (key) => !expectedKeys.has(key),
  )

  if (unknownKeys.length > 0) {
    throw new Error(
      `TaskSpecification has unknown field(s): ${unknownKeys.join(', ')}`,
    )
  }

  return {
    goal: requireNonEmptyString(value.goal, 'goal'),
    deliverables: requireStringArray(
      value.deliverables,
      'deliverables',
    ),
    tasks: requirePlannedTasks(value.tasks),
    constraints: requireStringArray(
      value.constraints,
      'constraints',
    ),
    acceptanceCriteria: requireStringArray(
      value.acceptanceCriteria,
      'acceptanceCriteria',
    ),
    outOfScope: requireStringArray(
      value.outOfScope,
      'outOfScope',
    ),
  }
}

/**
 * 解析并校验 Planner 输出的 JSON 文本。
 *
 * @param text - Planner 返回的 JSON 文本。
 * @returns 校验后的任务规格。
 */
export function parseTaskSpecificationJson(
  text: string,
): TaskSpecification {
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('TaskSpecification must contain valid JSON')
  }

  return validateTaskSpecification(value)
}

/**
 * 为 Working Agent 创建精简的系统指令。
 *
 * 规格只约束目标、边界和验收标准；具体文件、命令和技术方案由 Worker
 * 自己决定，因此不会把 Planner 变成第二个执行 Agent。
 *
 * @param specification - 已校验的任务规格。
 * @param progress - 当前任务执行进度。
 * @returns Working Agent 使用的系统指令。
 */
export function createWorkingAgentSystemPrompt(
  specification: TaskSpecification,
  progress: readonly TaskProgress[] = [],
): string {
  return [
    'You are the Working Agent in a coding-agent harness.',
    'Implement the task specification below.',
    'The specification defines WHAT must be achieved. You decide HOW to implement it.',
    'Use the available tools to inspect, modify, and verify the workspace.',
    'Respect all constraints and check the acceptance criteria before finishing.',
    'Do not replace the goal with a different task or repeatedly re-plan it.',
    'Work on one pending task at a time and use task_update to mark progress.',
    'Mark a task in_progress before working on it and completed only after verifying it.',
    'If a task cannot be completed, mark it blocked with a concise explanation.',
    'Return a final answer only after all feasible tasks and acceptance criteria are complete.',
    '',
    'TASK SPECIFICATION (JSON):',
    JSON.stringify(specification),
    '',
    'CURRENT TASK PROGRESS (JSON):',
    JSON.stringify(progress),
  ].join('\n')
}

/** 判断未知值是否为普通对象。 */
function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

/** 获取非空字符串字段。 */
function requireNonEmptyString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `TaskSpecification field "${field}" must be a non-empty string`,
    )
  }

  return value.trim()
}

/** 获取字符串数组，并复制和清理其中的字符串。 */
function requireStringArray(
  value: unknown,
  field: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `TaskSpecification field "${field}" must be an array`,
    )
  }

  return value.map((item, index) =>
    requireNonEmptyString(item, `${field}[${index}]`),
  )
}

/** 获取并校验 Planner 划分的任务目标。 */
function requirePlannedTasks(
  value: unknown,
): readonly PlannedTask[] {
  if (!Array.isArray(value)) {
    throw new Error('TaskSpecification field "tasks" must be an array')
  }

  const ids = new Set<string>()

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(
        `TaskSpecification field "tasks[${index}]" must be an object`,
      )
    }

    const keys = Object.keys(item)
    if (keys.some((key) => key !== 'id' && key !== 'objective')) {
      throw new Error(
        `TaskSpecification field "tasks[${index}]" has unknown field(s)`,
      )
    }

    const id = requireNonEmptyString(
      item.id,
      `tasks[${index}].id`,
    )
    if (ids.has(id)) {
      throw new Error(
        `TaskSpecification contains duplicate task id "${id}"`,
      )
    }
    ids.add(id)

    return {
      id,
      objective: requireNonEmptyString(
        item.objective,
        `tasks[${index}].objective`,
      ),
    }
  })
}
