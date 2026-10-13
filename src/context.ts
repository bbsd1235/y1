import { PluginRegistry } from './plugin-registry.js'
import { ServiceRegistry } from './service-registry.js'
import type { MiniPlugin } from './plugin.js'
import type { ServiceDisposer } from './service-registry.js'

/**
 * mini-dsh 的运行时上下文。
 *
 * Context 是插件之间共享的运行时容器。
 *
 * 当前 Context 提供：
 *
 * - service 注册和获取；
 * - plugin 加载；
 * - plugin 生命周期销毁。
 */
export class MiniContext {
  /**
   * Service 注册表。
   */
  private readonly services = new ServiceRegistry()

  /**
   * Plugin 注册表。
   */
  private readonly plugins = new PluginRegistry()

  /**
   * 注册一个 service。
   *
   * @param name - service 名称。
   * @param service - service 实例。
   * @returns 移除该 service 的 disposer。
   */
  provide<T>(name: string, service: T): ServiceDisposer {
    return this.services.provide(name, service)
  }

  /**
   * 获取一个 service。
   *
   * @param name - service 名称。
   * @returns 对应的 service。
   */
  get<T>(name: string): T {
    return this.services.get<T>(name)
  }

  /**
   * 判断 service 是否存在。
   *
   * @param name - service 名称。
   * @returns service 存在时返回 true。
   */
  has(name: string): boolean {
    return this.services.has(name)
  }

  /**
   * 加载一个插件。
   *
   * @param plugin - 要加载的插件。
   */
  use(plugin: MiniPlugin): void {
    this.plugins.use(plugin, this)
  }

  /**
   * 判断插件是否已经加载。
   *
   * @param name - 插件名称。
   * @returns 插件存在时返回 true。
   */
  hasPlugin(name: string): boolean {
    return this.plugins.has(name)
  }

  /**
   * 销毁 Context 中的全部插件。
   *
   * 插件 disposer 会负责移除插件创建的 service。
   */
  dispose(): void {
    this.plugins.dispose()
  }
}