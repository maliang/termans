import { create } from 'zustand'
import {
  themeDefinitionSchema,
  type ThemeDefinition,
  type ThemeToken,
  type ThemeTokenPatch
} from '@shared'
import { call, describeError, isNotImplemented, subscribe } from '../platform/ipc'
import { applyThemeToDocument, clearThemeOverrides } from './apply'
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  baseThemeFor,
  findBuiltinTheme,
  isBuiltinTheme,
  resolveBuiltinTheme,
  resolveThemeDefinition
} from './builtin'
import { auditContrast, contrastProblems, type ContrastResult } from './contrast'
import { resolveThemeTokens, type ResolvedTokens } from './tokens'
import {
  cloneThemeForEditing,
  parseThemeFile,
  serializeThemeFile,
  slugifyThemeId,
  validateTokenPatch,
  type ThemeIssue,
  type ThemeIssueCode
} from './validate'

/**
 * 主题状态机（zustand）。
 *
 * 三件事在这一层收口，组件只做展示：
 * 1. **持久化**：主题 id 存 `settings.themeId`（主进程 settings.json），用户主题存 `theme:*` IPC；
 *    主进程主题存储还没接线时（骨架期 `E_NOT_IMPLEMENTED`）自动降级到 localStorage，
 *    并把 `storage` 暴露给 UI 显示「本机暂存」提示 —— 不静默假装保存成功。
 * 2. **应用**：任何一次生效都走 `applyThemeToDocument()`（内联 52 个变量 + 通知 xterm）。
 * 3. **编辑**：`draft` 是正在编辑的主题副本，改动实时预览；`saveDraft()` 才落盘。
 *    自定义主题**不写进 Git 同步目录**（同步的是主机库/配置，主题是本机偏好），
 *    这一点与 vault-sync 的边界写在 docs/theming.md。
 */

export type ThemeStorageMode = 'ipc' | 'local' | 'unavailable'

export type ThemeErrorKey =
  | 'settings:themeError.invalidJson'
  | 'settings:themeError.notObject'
  | 'settings:themeError.invalidId'
  | 'settings:themeError.invalidName'
  | 'settings:themeError.nameRequired'
  | 'settings:themeError.builtinLocked'
  | 'settings:themeError.unknownToken'
  | 'settings:themeError.invalidColor'
  | 'settings:themeError.invalidLength'
  | 'settings:themeError.unsafeValue'
  | 'settings:themeError.invalidSchema'
  | 'settings:themeError.unknownBase'
  | 'settings:themeError.idTaken'
  | 'settings:themeError.builtinDelete'
  | 'settings:themeError.notFound'
  | 'settings:themeError.saveFailed'
  | 'settings:themeError.readFailed'

export interface ThemeError {
  key: ThemeErrorKey
  token?: string
  detail?: string
}

export type ThemeDraftOrigin = 'new' | 'edit'

export interface ThemeState {
  status: 'idle' | 'loading' | 'ready'
  storage: ThemeStorageMode
  customThemes: ThemeDefinition[]
  activeThemeId: string
  /** 正在编辑的副本；null 表示没有打开编辑器 */
  draft: ThemeDefinition | null
  draftOrigin: ThemeDraftOrigin | null
  /** 编辑时是否实时预览（关掉可以对比原主题） */
  previewing: boolean
  error: ThemeError | null
  savedAt: string | null

  init(): Promise<void>
  themeById(id: string): ThemeDefinition | undefined
  activeTheme(): ThemeDefinition
  activeTokens(): ResolvedTokens
  draftTokens(): ResolvedTokens | null
  activeContrast(): ContrastResult[]
  draftContrast(): ContrastResult[]

  selectTheme(id: string): Promise<void>
  resetToDefault(): Promise<void>
  beginCreate(baseId?: string): void
  beginEdit(id: string): void
  updateDraftField(patch: Partial<Pick<ThemeDefinition, 'name' | 'appearance' | 'extends'>>): void
  setDraftToken(token: ThemeToken, value: string): void
  resetDraftToken(token: ThemeToken): void
  setPreviewing(value: boolean): void
  discardDraft(): void
  saveDraft(): Promise<void>
  deleteTheme(id: string): Promise<void>
  importThemeFromText(text: string): Promise<void>
  exportThemeToText(id: string): string | null
  clearError(): void
}

const LOCAL_STORAGE_KEY = 'termans:themes:v1'

const ERROR_KEYS: Record<ThemeIssueCode, ThemeErrorKey> = {
  invalidJson: 'settings:themeError.invalidJson',
  notObject: 'settings:themeError.notObject',
  invalidId: 'settings:themeError.invalidId',
  invalidName: 'settings:themeError.invalidName',
  builtinLocked: 'settings:themeError.builtinLocked',
  unknownToken: 'settings:themeError.unknownToken',
  invalidColor: 'settings:themeError.invalidColor',
  invalidLength: 'settings:themeError.invalidLength',
  unsafeValue: 'settings:themeError.unsafeValue',
  invalidSchema: 'settings:themeError.invalidSchema',
  unknownBase: 'settings:themeError.unknownBase'
}

function toThemeError(issues: readonly ThemeIssue[]): ThemeError {
  const first = issues[0]
  if (!first) return { key: 'settings:themeError.invalidSchema' }
  return { key: ERROR_KEYS[first.code] ?? 'settings:themeError.invalidSchema', token: first.token, detail: first.detail }
}

/* -------------------------------------------------------------------------- */
/* 持久化：IPC 优先，未接线时降级 localStorage                                 */
/* -------------------------------------------------------------------------- */

let storageMode: ThemeStorageMode = 'unavailable'

function readLocalThemes(): ThemeDefinition[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      const result = themeDefinitionSchema.safeParse(item)
      return result.success && !result.data.builtin ? [result.data] : []
    })
  } catch {
    return []
  }
}

function writeLocalThemes(themes: readonly ThemeDefinition[]): void {
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(themes.map((theme) => ({ ...theme, builtin: false }))))
  } catch {
    // localStorage 不可用（隐私模式/配额满）时保持内存态，UI 会看到 storage='unavailable'
    storageMode = 'unavailable'
  }
}

async function loadCustomThemes(): Promise<ThemeDefinition[]> {
  try {
    const { themes } = await call('theme:list')
    storageMode = 'ipc'
    return themes.filter((theme) => !isBuiltinTheme(theme))
  } catch (error) {
    if (isNotImplemented(error)) {
      storageMode = 'local'
      return readLocalThemes()
    }
    storageMode = 'unavailable'
    return []
  }
}

async function persistCustomTheme(theme: ThemeDefinition): Promise<ThemeDefinition> {
  const payload: ThemeDefinition = { ...theme, builtin: false }
  if (storageMode !== 'local') {
    try {
      const { theme: saved } = await call('theme:save', { theme: payload })
      storageMode = 'ipc'
      return saved
    } catch (error) {
      if (!isNotImplemented(error)) throw error
      storageMode = 'local'
    }
  }
  writeLocalThemes([...readLocalThemes().filter((item) => item.id !== payload.id), payload])
  return payload
}

async function removeCustomTheme(id: string): Promise<void> {
  if (storageMode !== 'local') {
    try {
      await call('theme:delete', { themeId: id })
      storageMode = 'ipc'
      return
    } catch (error) {
      if (!isNotImplemented(error)) throw error
      storageMode = 'local'
    }
  }
  writeLocalThemes(readLocalThemes().filter((item) => item.id !== id))
}

/* -------------------------------------------------------------------------- */
/* 主题解析                                                                    */
/* -------------------------------------------------------------------------- */

function resolveDraftTokens(draft: ThemeDefinition): ResolvedTokens {
  const base = baseThemeFor(draft)
  return resolveThemeTokens(resolveBuiltinTheme(base), draft.tokens)
}

function mergedThemes(customThemes: readonly ThemeDefinition[]): ThemeDefinition[] {
  return [...BUILTIN_THEMES, ...customThemes]
}

function findTheme(id: string, customThemes: readonly ThemeDefinition[]): ThemeDefinition | undefined {
  return findBuiltinTheme(id) ?? customThemes.find((theme) => theme.id === id)
}

let initialized = false
let unsubscribeSettings: (() => void) | null = null

export const useThemeStore = create<ThemeState>((set, get) => {
  /** 把某个主题应用到 DOM（不落盘） */
  function applyTheme(id: string): void {
    const theme = findTheme(id, get().customThemes)
    if (!theme) {
      const fallback = findBuiltinTheme(DEFAULT_THEME_ID)!
      applyThemeToDocument(resolveBuiltinTheme(fallback), { id: fallback.id, appearance: fallback.appearance })
      set({ activeThemeId: fallback.id })
      return
    }
    applyThemeToDocument(resolveThemeDefinition(theme), { id: theme.id, appearance: theme.appearance })
    set({ activeThemeId: theme.id })
  }

  /** 编辑态实时预览（不影响已保存的 activeThemeId） */
  function previewDraft(): void {
    const { draft, previewing } = get()
    if (!draft || !previewing) return
    applyThemeToDocument(resolveDraftTokens(draft), {
      id: draft.id || 'draft',
      appearance: draft.appearance
    })
  }

  function restoreActive(): void {
    applyTheme(get().activeThemeId)
  }

  async function persistActiveThemeId(id: string): Promise<void> {
    try {
      await call('settings:update', { themeId: id })
    } catch (error) {
      // settings:update 是主进程真实通道；失败时主题仍然生效，只是重启不保留
      set({ error: { key: 'settings:themeError.saveFailed', detail: describeError(error) } })
    }
  }

  return {
    status: 'idle',
    storage: 'unavailable',
    customThemes: [],
    activeThemeId: DEFAULT_THEME_ID,
    draft: null,
    draftOrigin: null,
    previewing: true,
    error: null,
    savedAt: null,

    async init() {
      if (initialized) return
      initialized = true
      set({ status: 'loading' })
      const customThemes = await loadCustomThemes()
      set({ customThemes, storage: storageMode })

      let themeId: string = DEFAULT_THEME_ID
      try {
        const settings = await call('settings:get')
        themeId = settings.themeId
      } catch {
        // 主进程未接线时用默认主题；下面的订阅也一样会兜住后续变化
      }
      if (!findTheme(themeId, customThemes)) themeId = DEFAULT_THEME_ID
      applyTheme(themeId)
      set({ status: 'ready' })

      unsubscribeSettings?.()
      unsubscribeSettings = subscribe('settings:changed', (next) => {
        if (next.themeId === get().activeThemeId) return
        if (!get().draft) applyTheme(next.themeId)
        else set({ activeThemeId: next.themeId })
      })
    },

    themeById(id) {
      return findTheme(id, get().customThemes)
    },

    activeTheme() {
      return findTheme(get().activeThemeId, get().customThemes) ?? findBuiltinTheme(DEFAULT_THEME_ID)!
    },

    activeTokens() {
      return resolveThemeDefinition(get().activeTheme())
    },

    draftTokens() {
      const { draft } = get()
      return draft ? resolveDraftTokens(draft) : null
    },

    activeContrast() {
      return auditContrast(get().activeTokens())
    },

    draftContrast() {
      const tokens = get().draftTokens()
      return tokens ? contrastProblems(tokens) : []
    },

    async selectTheme(id) {
      const theme = findTheme(id, get().customThemes)
      if (!theme) {
        set({ error: { key: 'settings:themeError.notFound', detail: id } })
        return
      }
      set({ draft: null, draftOrigin: null })
      applyTheme(id)
      await persistActiveThemeId(id)
    },

    async resetToDefault() {
      set({ draft: null, draftOrigin: null, savedAt: null })
      clearThemeOverrides()
      applyTheme(DEFAULT_THEME_ID)
      await persistActiveThemeId(DEFAULT_THEME_ID)
    },

    beginCreate(baseId) {
      const base = findTheme(baseId ?? get().activeThemeId, get().customThemes)
      const baseTheme = base && isBuiltinTheme(base) ? base : findBuiltinTheme(DEFAULT_THEME_ID)!
      set({
        draft: {
          id: '',
          name: '',
          appearance: baseTheme.appearance,
          builtin: false,
          extends: baseTheme.id,
          tokens: {},
          createdAt: null,
          updatedAt: null
        },
        draftOrigin: 'new',
        previewing: true,
        error: null
      })
      previewDraft()
    },

    beginEdit(id) {
      const theme = findTheme(id, get().customThemes)
      if (!theme || isBuiltinTheme(theme)) {
        set({ error: { key: 'settings:themeError.builtinLocked', detail: id } })
        return
      }
      set({
        draft: cloneThemeForEditing(theme),
        draftOrigin: 'edit',
        previewing: true,
        error: null
      })
      previewDraft()
    },

    updateDraftField(patch) {
      const { draft } = get()
      if (!draft) return
      set({ draft: { ...draft, ...patch } })
      previewDraft()
    },

    setDraftToken(token, value) {
      const { draft } = get()
      if (!draft) return
      set({ draft: { ...draft, tokens: { ...draft.tokens, [token]: value } } })
      previewDraft()
    },

    resetDraftToken(token) {
      const { draft } = get()
      if (!draft) return
      const tokens: ThemeTokenPatch = { ...draft.tokens }
      delete tokens[token]
      set({ draft: { ...draft, tokens } })
      previewDraft()
    },

    setPreviewing(value) {
      set({ previewing: value })
      if (value) previewDraft()
      else restoreActive()
    },

    discardDraft() {
      set({ draft: null, draftOrigin: null, error: null })
      restoreActive()
    },

    async saveDraft() {
      const { draft, draftOrigin, customThemes } = get()
      if (!draft) return

      const name = draft.name.trim()
      if (name === '') {
        set({ error: { key: 'settings:themeError.nameRequired' } })
        return
      }

      const issues = validateTokenPatch(draft.tokens)
      if (issues.length > 0) {
        set({ error: toThemeError(issues) })
        return
      }

      const taken = mergedThemes(customThemes).map((theme) => theme.id)
      const id = draftOrigin === 'edit' && draft.id ? draft.id : slugifyThemeId(name, taken)
      const now = new Date().toISOString()

      const parsed = themeDefinitionSchema.safeParse({
        ...draft,
        id,
        name,
        builtin: false,
        extends: draft.extends ?? baseThemeFor(draft).id,
        updatedAt: now,
        createdAt: draft.createdAt ?? now
      })
      if (!parsed.success) {
        set({
          error: {
            key: 'settings:themeError.invalidSchema',
            detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
          }
        })
        return
      }

      try {
        const saved = await persistCustomTheme(parsed.data)
        const nextCustom = [...get().customThemes.filter((theme) => theme.id !== saved.id), saved]
        set({ customThemes: nextCustom, storage: storageMode, draft: null, draftOrigin: null, error: null, savedAt: now })
        applyTheme(saved.id)
        await persistActiveThemeId(saved.id)
      } catch (error) {
        set({ error: { key: 'settings:themeError.saveFailed', detail: describeError(error) } })
      }
    },

    async deleteTheme(id) {
      const theme = findTheme(id, get().customThemes)
      if (!theme) {
        set({ error: { key: 'settings:themeError.notFound', detail: id } })
        return
      }
      if (isBuiltinTheme(theme)) {
        set({ error: { key: 'settings:themeError.builtinDelete', detail: id } })
        return
      }
      try {
        await removeCustomTheme(id)
        const nextCustom = get().customThemes.filter((item) => item.id !== id)
        const wasActive = get().activeThemeId === id
        set({
          customThemes: nextCustom,
          storage: storageMode,
          ...(wasActive ? { activeThemeId: DEFAULT_THEME_ID, draft: null, draftOrigin: null } : {})
        })
        if (wasActive) {
          applyTheme(DEFAULT_THEME_ID)
          await persistActiveThemeId(DEFAULT_THEME_ID)
        }
      } catch (error) {
        set({ error: { key: 'settings:themeError.saveFailed', detail: describeError(error) } })
      }
    },

    async importThemeFromText(text) {
      const knownBaseIds = BUILTIN_THEMES.map((theme) => theme.id)
      const result = parseThemeFile(text, { knownBaseIds })
      if (!result.ok) {
        set({ error: toThemeError(result.issues) })
        return
      }
      const imported = result.theme
      if (findBuiltinTheme(imported.id)) {
        set({ error: { key: 'settings:themeError.idTaken', detail: imported.id } })
        return
      }
      try {
        const saved = await persistCustomTheme(imported)
        const nextCustom = [...get().customThemes.filter((theme) => theme.id !== saved.id), saved]
        set({ customThemes: nextCustom, storage: storageMode, error: null, savedAt: saved.updatedAt })
        applyTheme(saved.id)
        await persistActiveThemeId(saved.id)
      } catch (error) {
        set({ error: { key: 'settings:themeError.saveFailed', detail: describeError(error) } })
      }
    },

    exportThemeToText(id) {
      const theme = findTheme(id, get().customThemes)
      if (!theme) {
        set({ error: { key: 'settings:themeError.notFound', detail: id } })
        return null
      }
      return serializeThemeFile(theme)
    },

    clearError() {
      set({ error: null })
    }
  }
})

/** 供非 React 代码（测试、菜单命令）取当前状态 */
export function getThemeState(): ThemeState {
  return useThemeStore.getState()
}
