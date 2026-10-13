import type { MiniPlugin } from '../plugin.js'
import type { SessionPersistenceService } from '../services/session-persistence.js'
import {
  validateTaskSpecification,
  type TaskSpecification,
  type TaskSpecificationService,
} from '../services/task-specification.js'

/**
 * 保存当前任务规格的 Provider。
 *
 * JSONL Session 存在时，规格同时追加到 Session 日志；内存 Session 则只
 * 在当前 Context 生命周期内保存。
 */
export class DefaultTaskSpecificationService
  implements TaskSpecificationService
{
  private specification: TaskSpecification | undefined

  /**
   * @param persistence - 可选的 JSONL 持久化 Provider。
   */
  constructor(
    private readonly persistence?: SessionPersistenceService,
  ) {
    this.specification = persistence?.taskSpecification()
  }

  /** 返回当前任务规格的副本。 */
  current(): TaskSpecification | undefined {
    return this.specification === undefined
      ? undefined
      : validateTaskSpecification(this.specification)
  }

  /** 保存任务规格，并在可用时追加到 Session 日志。 */
  save(specification: TaskSpecification): void {
    const snapshot = validateTaskSpecification(specification)
    this.persistence?.saveTaskSpecification(snapshot)
    this.specification = snapshot
  }
}

/** 创建任务规格存储插件。 */
export function createTaskSpecificationPlugin(): MiniPlugin {
  return {
    name: 'task-specification',
    dependencies: ['session'],

    setup(context) {
      const persistence = context.has('session-persistence')
        ? context.get<SessionPersistenceService>('session-persistence')
        : undefined
      const service = new DefaultTaskSpecificationService(persistence)

      return context.provide<TaskSpecificationService>(
        'task-specification',
        service,
      )
    },
  }
}

/** 默认任务规格存储插件。 */
export const taskSpecificationPlugin = createTaskSpecificationPlugin()
