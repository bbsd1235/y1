import type { ModelService } from './model.js'

/**
 * Prompt Optimizer 使用的控制参数。
 */
export interface PromptOptimizerOptions {
  /** 当前工作目录；只作为上下文信息提供给模型。 */
  readonly workspaceRoot?: string
  /** 取消当前优化请求的信号。 */
  readonly signal?: AbortSignal
}

/**
 * Prompt Optimizer 服务。
 *
 * 它只负责把用户输入改写成更清晰的工作提示词，不负责制定任务计划、
 * 调用工具或执行 Agent Loop。
 */
export interface PromptOptimizerService {
  /**
   * 优化一条用户需求。
   *
   * @param input - 用户的原始需求。
   * @param options - 当前优化请求的上下文和控制参数。
   * @returns 可供 Working Agent 使用的优化提示词。
   */
  optimize(
    input: string,
    options?: PromptOptimizerOptions,
  ): Promise<string>
}

/**
 * Prompt Optimizer 的系统指令。
 *
 * Optimizer 只改善需求表达，不替 Worker 决定实现方式。
 */
export const PROMPT_OPTIMIZER_SYSTEM_PROMPT = `You are a lightweight Prompt Optimizer for a coding agent.

Rewrite the user's request into one concise, clear, and actionable work instruction.

Rules:
1. Preserve the user's original intent.
2. Clarify the desired result and add only useful verification guidance.
3. Use the supplied workspace information when it helps.
4. Make reasonable interpretations of obvious ambiguity, but do not invent unrelated requirements.
5. Do not create a detailed execution plan.
6. Do not choose specific files, commands, libraries, or implementation steps.
7. Do not write source code.
8. Return only the optimized work instruction, with no analysis or Markdown fences.
9. Keep the result concise.`

/**
 * 基于 ModelService 的轻量 Prompt Optimizer。
 */
export class ModelPromptOptimizerService
  implements PromptOptimizerService
{
  /**
   * @param model - 用于改写需求的模型服务。
   * @param systemPrompt - 可替换的 Optimizer 系统指令。
   */
  constructor(
    private readonly model: ModelService,
    private readonly systemPrompt: string = PROMPT_OPTIMIZER_SYSTEM_PROMPT,
  ) {}

  /** 请求模型生成优化后的工作提示词。 */
  async optimize(
    input: string,
    options: PromptOptimizerOptions = {},
  ): Promise<string> {
    const trimmedInput = input.trim()
    if (trimmedInput.length === 0) {
      throw new Error('prompt optimization input must not be empty')
    }

    const workspace = options.workspaceRoot?.trim()
    const context = workspace === undefined || workspace.length === 0
      ? '(workspace information unavailable)'
      : workspace

    const response = await this.model.complete({
      systemPrompt: this.systemPrompt,
      messages: [{
        role: 'user',
        content: [
          'USER REQUEST:',
          trimmedInput,
          '',
          'CURRENT WORKSPACE:',
          context,
        ].join('\n'),
      }],
      tools: [],
      signal: options.signal,
    })

    if (response.kind !== 'final') {
      throw new Error(
        'Prompt Optimizer must return a final response and cannot call tools',
      )
    }

    const optimizedPrompt = response.content.trim()
    if (optimizedPrompt.length === 0) {
      throw new Error('Prompt Optimizer returned an empty response')
    }

    return optimizedPrompt
  }
}
