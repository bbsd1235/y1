import type { MiniPlugin } from '../plugin.js'
import type {
  ToolArguments,
  ToolDefinition,
  ToolSchema,
  ToolRisk,
  ToolsService,
} from '../services/tools.js'

/**
 * 内存 Tool Registry。
 *
 * 它负责保存工具定义，并提供：
 *
 * - 工具注册；
 * - 工具注销；
 * - 模型可见 schema；
 * - 工具执行。
 */
export class InMemoryToolsService implements ToolsService {
  /**
   * 工具定义表。
   *
   * key 是工具名称。
   */
  private readonly definitions = new Map<string, ToolDefinition>()

  /**
   * 注册一个工具。
   *
   * 当前版本禁止同名工具重复注册。
   *
   * @param definition - 工具定义。
   * @returns 移除该工具的 disposer。
   */
  register(definition: ToolDefinition): () => void {
    if (definition.name.trim().length === 0) {
      throw new Error('tool name must not be empty')
    }

    if (this.definitions.has(definition.name)) {
      throw new Error(
        `tool "${definition.name}" is already registered`,
      )
    }

    this.definitions.set(definition.name, definition)

    let disposed = false

    return () => {
      if (disposed) {
        return
      }

      disposed = true

      // 只有当前注册仍然对应这个 definition 时才删除。
      // 这样可以避免未来支持替换工具时误删新注册。
      if (this.definitions.get(definition.name) === definition) {
        this.definitions.delete(definition.name)
      }
    }
  }

  /**
   * 返回模型可见的工具 schema。
   *
   * execute() 不会出现在返回值中。
   *
   * @returns 当前注册工具的 schema。
   */
  schemas(): readonly ToolSchema[] {
    return [...this.definitions.values()].map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: { ...definition.parameters },
    }))
  }

  /** 返回工具的权限风险级别。 */
  risk(name: string, args?: ToolArguments): ToolRisk {
    const definition = this.definitions.get(name)

    if (definition === undefined) {
      throw new Error(`tool "${name}" is not registered`)
    }

    return definition.riskFor?.(args ?? {}) ?? definition.risk
  }

  /**
   * 执行一个工具。
   *
   * @param name - 工具名称。
   * @param args - 工具参数。
   * @returns 工具执行结果。
   */
  async execute(
    name: string,
    args: ToolArguments,
    signal?: AbortSignal,
  ): Promise<string> {
    const definition = this.definitions.get(name)

    if (definition === undefined) {
    throw new Error(`tool "${name}" is not registered`)
  }

    return definition.execute(args, signal)
  }
}

/**
 * Tool Registry 插件。
 *
 * 该插件提供 "tools" service。
 */
export const toolsPlugin: MiniPlugin = {
  name: 'tools',

  setup(context) {
    const tools = new InMemoryToolsService()

    return context.provide('tools', tools)
  },
}
