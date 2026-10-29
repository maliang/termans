import { z } from 'zod'
import { BUILTIN_THEME_IDS, IpcCallError, themeDefinitionSchema, type ThemeDefinition } from '@shared'
import { JsonStore } from '../store/json-store'
import { handle } from './registry'

/**
 * 自定义主题的持久化（`theme:list` / `theme:save` / `theme:delete`）。
 *
 * 落点与同步边界（重要，别改）：
 * - 存 `<userData>/themes.json`，**不进密文包、不进 Git 同步**。主题是「外观偏好」，
 *   没有敏感信息；放进 vault 会让「改个颜色」也触发一次密文重写 + 同步冲突，代价远大于收益。
 *   这也是渲染层 theme 模块能在解锁前就把主题画出来的原因（首屏不该等用户输口令）。
 * - 内置主题（`BUILTIN_THEME_IDS`）只读：它们编译进渲染层（`src/renderer/theme/builtin.ts`），
 *   主进程这边拒绝覆盖/删除，否则用户能把自己「删掉默认主题」到无法回退。
 * - 写入按 id upsert（同一主题反复保存 = 更新），`updatedAt` 由主进程盖章，不信任渲染层时钟。
 */

const THEME_FILE_NAME = 'themes.json'

export interface ThemeFile {
  schemaVersion: 1
  themes: ThemeDefinition[]
}

const themeFileSchema = z.object({
  schemaVersion: z.literal(1),
  themes: z.array(themeDefinitionSchema)
})

const saveRequestSchema = z.object({ theme: themeDefinitionSchema }).strict()
const deleteRequestSchema = z.object({ themeId: z.string().min(1).max(120) }).strict()

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_THEME_IDS)

export interface ThemeHandlerContext {
  /** 通常是 `app.getPath('userData')` */
  userDataDir: string
  /** 注入时钟便于单测；默认 `new Date()` */
  now?: () => Date
}

function invalid(message: string): IpcCallError {
  return new IpcCallError({ code: 'E_INVALID_ARGUMENT', message })
}

export function registerThemeHandlers(context: ThemeHandlerContext): void {
  const now = context.now ?? ((): Date => new Date())
  const store = new JsonStore<ThemeFile>({
    dir: context.userDataDir,
    fileName: THEME_FILE_NAME,
    defaults: (): ThemeFile => ({ schemaVersion: 1, themes: [] }),
    normalize: (raw, fallback) => {
      const parsed = themeFileSchema.safeParse(raw)
      return parsed.success ? parsed.data : fallback
    }
  })

  handle('theme:list', () => ({ themes: store.read().themes }))

  handle(
    'theme:save',
    (request) => {
      const incoming = request.theme
      if (BUILTIN_IDS.has(incoming.id)) {
        throw invalid(`Built-in theme cannot be overwritten: ${incoming.id}`)
      }
      if (incoming.id.trim().length === 0) throw invalid('Theme id must not be empty')
      if (incoming.name.trim().length === 0) throw invalid('Theme name must not be empty')

      const stamp = now().toISOString()
      const existing = store.read().themes.find((theme) => theme.id === incoming.id)
      const saved: ThemeDefinition = {
        ...incoming,
        builtin: false,
        createdAt: existing?.createdAt ?? incoming.createdAt ?? stamp,
        updatedAt: stamp
      }
      store.update((current) => ({
        schemaVersion: 1,
        themes: [...current.themes.filter((theme) => theme.id !== saved.id), saved]
      }))
      return { theme: saved }
    },
    saveRequestSchema
  )

  handle(
    'theme:delete',
    (request) => {
      const { themeId } = request
      if (BUILTIN_IDS.has(themeId)) {
        throw invalid(`Built-in theme cannot be deleted: ${themeId}`)
      }
      // 幂等：删不存在的主题不报错（用户连点两次 / 另一端已删，都不该弹「删除失败」）
      const current = store.read()
      if (!current.themes.some((theme) => theme.id === themeId)) return
      store.update((snapshot) => ({
        schemaVersion: 1,
        themes: snapshot.themes.filter((theme) => theme.id !== themeId)
      }))
    },
    deleteRequestSchema
  )
}
