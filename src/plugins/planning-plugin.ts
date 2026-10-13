import type { MiniPlugin } from '../plugin.js'
import {
  ModelPlanningService,
  type PlanningService,
} from '../services/planning.js'
import type { ModelService } from '../services/model.js'

/**
 * 创建 Planning Plugin。
 *
 * 该插件只负责需求规划，不执行工具，也不修改 Agent Loop。
 *
 * @returns 提供 `planning` service 的插件。
 */
export function createPlanningPlugin(): MiniPlugin {
  return {
    name: 'planning',
    dependencies: ['model'],

    setup(context) {
      const model = context.get<ModelService>('model')
      const planning = new ModelPlanningService(model)

      return context.provide<PlanningService>(
        'planning',
        planning,
      )
    },
  }
}

/** 默认 Planning Plugin。 */
export const planningPlugin = createPlanningPlugin()
