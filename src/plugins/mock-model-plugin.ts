import type { MiniPlugin } from '../plugin.js'
import type {
  ModelRequest,
  ModelResponse,
  ModelService,
} from '../services/model.js'

/**
 * Mock Model 的响应函数。
 *
 * requestIndex 从 0 开始，表示这是当前 Mock Model
 * 收到的第几次请求。
 */
export type MockModelResponder = (
  request: ModelRequest,
  requestIndex: number,
) => ModelResponse | Promise<ModelResponse>

/**
 * Mock Model 插件配置。
 */
export interface MockModelPluginOptions {
  /**
   * 自定义响应逻辑。
   *
   * 不提供时使用默认响应。
   */
  readonly responder?: MockModelResponder
}

/**
 * 内存 Mock Model Service。
 *
 * 它不访问网络，只根据请求返回确定性响应。
 * 后续可以通过 responder 模拟：
 *
 * - 最终文本；
 * - 工具调用；
 * - 多步骤模型行为；
 * - 模型错误。
 */
export class MockModelService implements ModelService {
  /**
   * 已处理的模型请求数量。
   */
  private requestCount = 0

  /**
   * @param responder - 自定义模型响应函数。
   */
  constructor(
    private readonly responder: MockModelResponder = defaultResponder,
  ) {}

  /**
   * 请求 Mock Model。
   *
   * @param request - 模型请求。
   * @returns 模型响应。
   */
  async complete(request: ModelRequest): Promise<ModelResponse> {
    throwIfAborted(request.signal)

    const requestIndex = this.requestCount
    this.requestCount += 1

    const response = await this.responder(request, requestIndex)
    throwIfAborted(request.signal)
    return response
  }

  /**
   * 返回已经处理的请求数量。
   *
   * 主要用于测试和调试。
   *
   * @returns 请求次数。
   */
  getRequestCount(): number {
    return this.requestCount
  }
}

/** 让 Mock Model 的异步响应也遵守 Agent Run 的取消协议。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('agent run cancelled')
  }
}

/**
 * Mock Model 的默认响应。
 *
 * 默认只返回最终文本，不发起工具调用。
 *
 * @param request - 模型请求。
 * @returns 默认模型响应。
 */
function defaultResponder(request: ModelRequest): ModelResponse {
  const lastMessage = request.messages[request.messages.length - 1]

  if (lastMessage === undefined) {
    return {
      kind: 'final',
      content: 'mock model received an empty conversation',
    }
  }

  if (request.systemPrompt?.includes('You are the Planning Agent')) {
    return {
      kind: 'final',
      content: JSON.stringify({
        goal: lastMessage.content,
        deliverables: ['A completed result'],
        tasks: [{
          id: 'complete-task',
          objective: lastMessage.content,
        }],
        constraints: [],
        acceptanceCriteria: ['The requested result is complete'],
        outOfScope: [],
      }),
    }
  }

  if (request.systemPrompt?.includes('lightweight Prompt Optimizer')) {
    return {
      kind: 'final',
      content: `Complete the user's request in the current workspace.\n\n${lastMessage.content}`,
    }
  }

  return {
    kind: 'final',
    content: `mock model received: ${lastMessage.content}`,
  }
}

/**
 * 创建一个可配置的 Mock Model 插件。
 *
 * 使用工厂函数是为了让不同测试或不同组合可以使用不同的
 * Mock Model 响应逻辑。
 *
 * @param options - Mock Model 配置。
 * @returns 一个 model 插件。
 */
export function createMockModelPlugin(
  options: MockModelPluginOptions = {},
): MiniPlugin {
  return {
    name: 'model',

    setup(context) {
      const model = new MockModelService(options.responder)

      return context.provide('model', model)
    },
  }
}

/**
 * 默认 Mock Model 插件。
 */
export const mockModelPlugin = createMockModelPlugin()
