import type { ModelService } from './model.js'
import {
  parseTaskSpecificationJson,
  type TaskSpecification,
} from './task-specification.js'

/**
 * Planner 使用的系统指令。
 *
 * 该指令明确限制 Planner 的职责：定义目标和验收标准，但不替 Worker
 * 选择文件、命令或具体技术实现。
 */
export const PLANNER_SYSTEM_PROMPT = `You are the Planning Agent in a coding-agent harness.

Your only responsibility is to turn the user's request into a concise, structured task specification.
You decide WHAT must be achieved. You do not decide HOW it will be implemented.

Rules:
1. Extract the overall goal and the expected deliverables.
2. Break the goal into a small ordered list of concrete task objectives.
3. State important constraints and explicit acceptance criteria.
4. State what is out of scope when the request implies a clear boundary.
5. Do not provide source code, file names, shell commands, library choices, or implementation steps.
6. Do not describe your reasoning.
7. Return ONLY one valid JSON object. Do not use Markdown fences or any text before or after the JSON.

The JSON object must have exactly this structure:
{
  "goal": "string",
  "deliverables": ["string"],
  "tasks": [
    {"id": "short-stable-id", "objective": "what must be achieved"}
  ],
  "constraints": ["string"],
  "acceptanceCriteria": ["string"],
  "outOfScope": ["string"]
}

Keep the specification concise. Use 1 to 8 task objectives. Preserve user requirements, but do not invent implementation details.`

/** Planner 请求的控制参数。 */
export interface PlanningOptions {
  /** 取消当前 Planner 请求的信号。 */
  readonly signal?: AbortSignal
}

/** CLI 或其他交互层提供的计划确认函数。 */
export type PlanApprovalHandler = (
  specification: TaskSpecification,
  signal?: AbortSignal,
) => boolean | Promise<boolean>

/** Planner 服务。 */
export interface PlanningService {
  /**
   * 将用户需求转换为结构化任务规格。
   *
   * @param input - 用户的自然语言需求。
   * @param options - 当前 Planner 请求的控制参数。
   * @returns 校验后的任务规格。
   */
  createSpecification(
    input: string,
    options?: PlanningOptions,
  ): Promise<TaskSpecification>
}

/** 基于 ModelService 的 Planner 实现。 */
export class ModelPlanningService implements PlanningService {
  /**
   * @param model - 用于生成任务规格的模型服务。
   * @param systemPrompt - Planner 的系统指令。
   */
  constructor(
    private readonly model: ModelService,
    private readonly systemPrompt: string = PLANNER_SYSTEM_PROMPT,
  ) {}

  /**
   * 请求模型生成并校验 TaskSpecification。
   *
   * Planner 不接收工具 schema，因此不能在规划阶段修改 workspace。
   *
   * @param input - 用户的自然语言需求。
   * @param options - 当前 Planner 请求的控制参数。
   * @returns 校验后的任务规格。
   */
  async createSpecification(
    input: string,
    options: PlanningOptions = {},
  ): Promise<TaskSpecification> {
    if (input.trim().length === 0) {
      throw new Error('planning input must not be empty')
    }

    const response = await this.model.complete({
      systemPrompt: this.systemPrompt,
      messages: [{
        role: 'user',
        content: input,
      }],
      tools: [],
      signal: options.signal,
    })

    if (response.kind !== 'final') {
      throw new Error(
        'Planner must return a final JSON response and cannot call tools',
      )
    }

    try {
      return parseTaskSpecificationJson(response.content)
    } catch (error: unknown) {
      throw new Error(
        `Planner returned an invalid TaskSpecification: ${getErrorMessage(error)}`,
      )
    }
  }
}

/** 将未知错误转换为可读文本。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
