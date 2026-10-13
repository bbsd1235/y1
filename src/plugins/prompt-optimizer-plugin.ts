import type { MiniPlugin } from '../plugin.js'
import type { ModelService } from '../services/model.js'
import {
  ModelPromptOptimizerService,
  type PromptOptimizerService,
} from '../services/prompt-optimizer.js'

/**
 * 创建 Prompt Optimizer 插件。
 *
 * @returns 提供 `prompt-optimizer` service 的插件。
 */
export function createPromptOptimizerPlugin(): MiniPlugin {
  return {
    name: 'prompt-optimizer',
    dependencies: ['model'],

    setup(context) {
      const model = context.get<ModelService>('model')
      const optimizer = new ModelPromptOptimizerService(model)

      return context.provide<PromptOptimizerService>(
        'prompt-optimizer',
        optimizer,
      )
    },
  }
}

/** 默认 Prompt Optimizer 插件。 */
export const promptOptimizerPlugin = createPromptOptimizerPlugin()
