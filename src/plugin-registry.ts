import type { MiniContext } from './context.js'
import type { MiniPlugin, PluginDisposer } from './plugin.js'

/**
 * 插件注册表。
 *
 * PluginRegistry 负责：
 *
 * - 加载插件；
 * - 检查插件依赖；
 * - 防止同名插件重复加载；
 * - 保存插件 disposer；
 * - 按逆序销毁插件；
 * - 保证 dispose() 幂等。
 */
export class PluginRegistry {
  /**
   * 已加载插件的清理函数。
   *
   * key 是插件名称。
   * value 是插件 setup() 返回的 disposer。
   */
  private readonly plugins = new Map<string, PluginDisposer>()

  /**
   * 标记整个 registry 是否已经销毁。
   */
  private disposed = false

  /**
   * 加载一个插件。
   *
   * 加载顺序：
   *
   * 1. 检查 registry 是否已经销毁；
   * 2. 检查插件名称；
   * 3. 检查插件是否重复；
   * 4. 检查插件依赖；
   * 5. 执行 setup();
   * 6. 保存 disposer。
   *
   * @param plugin - 要加载的插件。
   * @param context - 运行时上下文。
   */
  use(plugin: MiniPlugin, context: MiniContext): void {
    if (this.disposed) {
      throw new Error('plugin registry is already disposed')
    }

    if (plugin.name.trim().length === 0) {
      throw new Error('plugin name must not be empty')
    }

    if (this.plugins.has(plugin.name)) {
      throw new Error(`plugin "${plugin.name}" is already registered`)
    }

    this.assertDependencies(plugin, context)

    // 只有依赖检查成功后，才执行插件初始化。
    // 如果 setup() 抛错，插件不会进入 plugins Map。
    const disposer = plugin.setup(context)

    // 没有创建资源的插件使用空 disposer。
    const cleanup: PluginDisposer =
      typeof disposer === 'function'
        ? disposer
        : () => {}

    this.plugins.set(plugin.name, cleanup)
  }

  /**
   * 检查插件声明的 service 依赖是否都存在。
   *
   * @param plugin - 要检查的插件。
   * @param context - 运行时上下文。
   */
  private assertDependencies(
    plugin: MiniPlugin,
    context: MiniContext,
  ): void {
    for (const dependency of plugin.dependencies ?? []) {
      if (dependency.trim().length === 0) {
        throw new Error(
          `plugin "${plugin.name}" declares an empty dependency`,
        )
      }

      if (!context.has(dependency)) {
        throw new Error(
          `plugin "${plugin.name}" requires service "${dependency}"`,
        )
      }
    }
  }

  /**
   * 判断插件是否已经加载。
   *
   * @param name - 插件名称。
   * @returns 插件存在时返回 true。
   */
  has(name: string): boolean {
    return this.plugins.has(name)
  }

  /**
   * 销毁所有插件。
   *
   * 插件按照加载顺序的逆序销毁。
   *
   * 即：
   *
   * A -> B -> C
   *
   * 销毁顺序是：
   *
   * C -> B -> A
   *
   * 即使某个 disposer 抛出异常，也会继续清理其他插件。
   * 最后重新抛出第一个清理错误。
   */
  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true

    const cleanups = [...this.plugins.values()].reverse()

    let cleanupFailed = false
    let firstError: unknown

    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch (error: unknown) {
        if (!cleanupFailed) {
          cleanupFailed = true
          firstError = error
        }
      }
    }

    this.plugins.clear()

    if (cleanupFailed) {
      throw firstError
    }
  }
}