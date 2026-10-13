import type { MiniContext } from './context.js'

/**
 * 插件销毁函数。
 *
 * 插件在 setup() 阶段创建资源后，可以返回一个 disposer。
 * 插件被销毁时，PluginRegistry 会调用这个函数。
 */
export type PluginDisposer = () => void

/**
 * mini-dsh 当前阶段的插件接口。
 */
export interface MiniPlugin {
  /**
   * 插件名称。
   *
   * 插件名称必须唯一。
   */
  readonly name: string

  /**
   * 插件依赖的 service 名称。
   *
   * 例如 agent-loop 可能依赖：
   *
   * ['model', 'tools', 'session']
   *
   * 当前版本中，依赖缺失时会立即抛错。
   */
  readonly dependencies?: readonly string[]

  /**
   * 初始化插件。
   *
   * setup 只有在所有依赖 service 都存在时才会被调用。
   *
   * @param context - mini-dsh 运行时上下文。
   * @returns 插件销毁函数。
   */
  setup(context: MiniContext): void | PluginDisposer
}