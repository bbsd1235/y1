import type { MiniPlugin } from '../plugin.js'
import {
  type TaskProgressStatus,
  type TaskProgressService,
} from '../services/task-progress.js'
import type { ToolArguments, ToolsService } from '../services/tools.js'

/** 创建 task_update 工具插件。 */
export function createTaskUpdateToolPlugin(): MiniPlugin {
  return {
    name: 'task-update-tool',
    dependencies: ['tools', 'task-progress'],

    setup(context) {
      const tools = context.get<ToolsService>('tools')
      const progress = context.get<TaskProgressService>('task-progress')

      return tools.register({
        name: 'task_update',
        risk: 'agent-state',
        description: 'Update the execution status of a planned task.',
        parameters: {
          type: 'object',
          properties: {
            taskId: {
              type: 'string',
              description: 'The task id from the task specification.',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'blocked'],
              description: 'The new task status.',
            },
            summary: {
              type: 'string',
              description: 'A short summary of the current state.',
            },
          },
          required: ['taskId', 'status'],
          additionalProperties: false,
        },
        async execute(args) {
          const taskId = requireString(args, 'taskId')
          const status = requireStatus(args)
          const summary = args.summary === undefined
            ? undefined
            : requireString(args, 'summary')
          progress.update(taskId, status, summary)
          return JSON.stringify(progress.current())
        },
      })
    },
  }
}

/** 默认 task_update 工具插件。 */
export const taskUpdateToolPlugin = createTaskUpdateToolPlugin()

/** 读取非空字符串参数。 */
function requireString(args: ToolArguments, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`argument "${name}" must be a non-empty string`)
  }
  return value.trim()
}

/** 读取合法任务状态。 */
function requireStatus(args: ToolArguments): TaskProgressStatus {
  const value = requireString(args, 'status')
  if (
    value !== 'pending' &&
    value !== 'in_progress' &&
    value !== 'completed' &&
    value !== 'blocked'
  ) {
    throw new Error(`argument "status" has unsupported value "${value}"`)
  }
  return value
}
