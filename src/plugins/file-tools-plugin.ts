import {
  lstat,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises'
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'
import type { MiniPlugin } from '../plugin.js'
import type { ToolArguments, ToolsService } from '../services/tools.js'

/**
 * 文件工具插件配置。
 */
export interface FileToolsPluginOptions {
  /**
   * 文件工具允许访问的根目录。
   *
   * 不传时默认使用当前进程工作目录。
   */
  readonly rootDir?: string
}

/**
 * 创建文件工具插件。
 *
 * 该插件依赖已经存在的 "tools" service，
 * 并向其中注册 read_file、write_file、edit_file、delete_file、list_files。
 *
 * @param options - 文件工具配置。
 * @returns 文件工具插件。
 */
export function createFileToolsPlugin(
  options: FileToolsPluginOptions = {},
): MiniPlugin {
  const rootDir = resolve(options.rootDir ?? process.cwd())

  return {
    name: 'file-tools',

    dependencies: ['tools'],

    setup(context) {
      const tools = context.get<ToolsService>('tools')
      const disposers: Array<() => void> = []

      try {
        disposers.push(
          tools.register({
            name: 'read_file',
            risk: 'read-only',
            description: 'Read a UTF-8 text file from the workspace.',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Path relative to the workspace root.',
                },
              },
              required: ['path'],
              additionalProperties: false,
            },
            async execute(args) {
              const inputPath = requireStringArgument(args, 'path')
              const filePath = await resolveExistingPath(
                rootDir,
                inputPath,
              )

              return readFile(filePath, 'utf8')
            },
          }),
        )

        disposers.push(
          tools.register({
            name: 'write_file',
            risk: 'workspace-write',
            description: 'Write UTF-8 text to a file in the workspace.',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Path relative to the workspace root.',
                },
                content: {
                  type: 'string',
                  description: 'Text content to write.',
                },
              },
              required: ['path', 'content'],
              additionalProperties: false,
            },
            async execute(args) {
              const inputPath = requireStringArgument(args, 'path')
              const content = requireStringContent(args, 'content')
              const filePath = await resolveWritePath(
                rootDir,
                inputPath,
              )

              await writeFile(filePath, content, 'utf8')

              return `wrote file: ${inputPath}`
            },
          }),
        )

        disposers.push(
          tools.register({
            name: 'edit_file',
            risk: 'workspace-write',
            description:
              'Replace exactly one occurrence of text in a workspace file.',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Path relative to the workspace root.',
                },
                oldText: {
                  type: 'string',
                  description: 'The exact text to replace once.',
                },
                newText: {
                  type: 'string',
                  description: 'The replacement text.',
                },
              },
              required: ['path', 'oldText', 'newText'],
              additionalProperties: false,
            },
            async execute(args) {
              const inputPath = requireStringArgument(args, 'path')
              const oldText = requireStringContent(args, 'oldText')
              const newText = requireStringContent(args, 'newText')
              if (oldText.length === 0) {
                throw new Error('argument "oldText" must not be empty')
              }

              const filePath = await resolveExistingPath(
                rootDir,
                inputPath,
              )
              const currentContent = await readFile(filePath, 'utf8')
              const firstIndex = currentContent.indexOf(oldText)

              if (firstIndex === -1) {
                throw new Error(
                  `text to replace was not found in file: ${inputPath}`,
                )
              }

              const secondIndex = currentContent.indexOf(
                oldText,
                firstIndex + oldText.length,
              )
              if (secondIndex !== -1) {
                throw new Error(
                  `text to replace occurs more than once in file: ${inputPath}`,
                )
              }

              const updatedContent =
                currentContent.slice(0, firstIndex) +
                newText +
                currentContent.slice(firstIndex + oldText.length)
              await writeFile(filePath, updatedContent, 'utf8')

              return `edited file: ${inputPath}`
            },
          }),
        )

        disposers.push(
          tools.register({
            name: 'delete_file',
            risk: 'workspace-write',
            description: 'Delete a file from the workspace.',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Path relative to the workspace root.',
                },
              },
              required: ['path'],
              additionalProperties: false,
            },
            async execute(args) {
              const inputPath = requireStringArgument(args, 'path')
              const filePath = await resolveExistingPath(
                rootDir,
                inputPath,
              )
              const fileStat = await lstat(filePath)
              if (!fileStat.isFile()) {
                throw new Error(
                  `path is not a regular file: ${inputPath}`,
                )
              }

              await unlink(filePath)
              return `deleted file: ${inputPath}`
            },
          }),
        )

        disposers.push(
          tools.register({
            name: 'list_files',
            risk: 'read-only',
            description: 'List files and directories in the workspace.',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description:
                    'Directory path relative to the workspace root.',
                },
              },
              required: ['path'],
              additionalProperties: false,
            },
            async execute(args) {
              const inputPath = requireStringArgument(args, 'path')
              const directoryPath = await resolveExistingPath(
                rootDir,
                inputPath,
              )

              const entries = await readdir(directoryPath, {
                withFileTypes: true,
              })

              const result = entries
                .sort((left, right) =>
                  left.name.localeCompare(right.name),
                )
                .map((entry) => ({
                  name: entry.name,
                  type: entry.isDirectory()
                    ? 'directory'
                    : entry.isFile()
                      ? 'file'
                      : 'other',
                }))

              return JSON.stringify(result, null, 2)
            },
          }),
        )
      } catch (error: unknown) {
        // 如果注册中途失败，清理已经成功注册的工具。
        for (const dispose of disposers.reverse()) {
          dispose()
        }

        throw error
      }

      // 插件销毁时，注销本插件注册的全部工具。
      return () => {
        for (const dispose of disposers.reverse()) {
          dispose()
        }
      }
    },
  }
}

/**
 * 默认文件工具插件。
 *
 * 默认允许访问 process.cwd()。
 */
export const fileToolsPlugin = createFileToolsPlugin()

/**
 * 获取非空字符串参数。
 *
 * @param args - 工具参数。
 * @param name - 参数名称。
 * @returns 参数字符串。
 */
function requireStringArgument(
  args: ToolArguments,
  name: string,
): string {
  const value = args[name]

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `argument "${name}" must be a non-empty string`,
    )
  }

  return value
}

/**
 * 获取允许为空的字符串参数。
 *
 * write_file 的 content 可以是空字符串，
 * 因此不能复用 requireStringArgument。
 *
 * @param args - 工具参数。
 * @param name - 参数名称。
 * @returns 参数字符串。
 */
function requireStringContent(
  args: ToolArguments,
  name: string,
): string {
  const value = args[name]

  if (typeof value !== 'string') {
    throw new Error(`argument "${name}" must be a string`)
  }

  return value
}

/**
 * 检查路径是否位于工作区内。
 *
 * @param rootDir - 工作区根目录。
 * @param targetPath - 待检查的绝对路径。
 */
function assertInsideRoot(
  rootDir: string,
  targetPath: string,
): void {
  const relativePath = relative(rootDir, targetPath)

  const escapesRoot =
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)

  if (escapesRoot) {
    throw new Error(
      `path "${targetPath}" is outside the workspace`,
    )
  }
}

/**
 * 将用户输入路径解析到工作区内。
 *
 * 这里先进行词法路径检查。
 *
 * @param rootDir - 工作区根目录。
 * @param inputPath - 用户传入的相对或绝对路径。
 * @returns 工作区内的绝对路径。
 */
function resolveInsideRoot(
  rootDir: string,
  inputPath: string,
): string {
  const targetPath = resolve(rootDir, inputPath)

  assertInsideRoot(rootDir, targetPath)

  return targetPath
}

/**
 * 解析一个已经存在的文件或目录。
 *
 * realpath 可以检查已经存在的软链接是否指向工作区外部。
 *
 * @param rootDir - 工作区根目录。
 * @param inputPath - 用户传入的路径。
 * @returns 检查后的真实路径。
 */
async function resolveExistingPath(
  rootDir: string,
  inputPath: string,
): Promise<string> {
  const targetPath = resolveInsideRoot(rootDir, inputPath)
  const realPath = await realpath(targetPath)

  assertInsideRoot(rootDir, realPath)

  return realPath
}

/**
 * 解析写入目标路径。
 *
 * 新文件可能还不存在，所以不能直接对目标调用 realpath。
 * 这里检查父目录，以及已经存在的目标文件。
 *
 * @param rootDir - 工作区根目录。
 * @param inputPath - 用户传入的路径。
 * @returns 检查后的写入路径。
 */
async function resolveWritePath(
  rootDir: string,
  inputPath: string,
): Promise<string> {
  const targetPath = resolveInsideRoot(rootDir, inputPath)

  const parentPath = await realpath(dirname(targetPath))
  assertInsideRoot(rootDir, parentPath)

  let targetExists = false

  try {
    await lstat(targetPath)
    targetExists = true
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
      throw error
    }
  }

  if (targetExists) {
    const realTargetPath = await realpath(targetPath)
    assertInsideRoot(rootDir, realTargetPath)
  }

  return targetPath
}

/**
 * 判断错误是否表示目标不存在。
 *
 * @param error - 捕获到的未知错误。
 * @returns 如果是 ENOENT，则返回 true。
 */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
