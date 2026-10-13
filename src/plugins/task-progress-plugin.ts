import type { MiniPlugin } from '../plugin.js'
import type { SessionPersistenceService } from '../services/session-persistence.js'
import {
  DefaultTaskProgressService,
  type TaskProgressService,
} from '../services/task-progress.js'

/** 创建任务进度插件。 */
export function createTaskProgressPlugin(): MiniPlugin {
  return {
    name: 'task-progress',
    dependencies: ['session', 'task-specification'],

    setup(context) {
      const persistence = context.has('session-persistence')
        ? context.get<SessionPersistenceService>('session-persistence')
        : undefined
      const progress = new DefaultTaskProgressService(persistence)
      return context.provide<TaskProgressService>('task-progress', progress)
    },
  }
}

/** 默认任务进度插件。 */
export const taskProgressPlugin = createTaskProgressPlugin()
