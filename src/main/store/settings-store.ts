import {
  DEFAULT_SETTINGS,
  settingsPatchSchema,
  settingsSchema,
  withDefaults,
  type Settings,
  type SettingsPatch
} from '@shared'
import { JsonStore } from './json-store'

/**
 * 设置存储：`<userData>/settings.json`。
 *
 * 读写都是「整份 Settings」，写入前用 zod 校验；读取时用 `withDefaults` 补齐旧版本/残缺字段，
 * 因此渲染层永远拿到完整对象，不用到处写 `settings.ai?.enabled ?? false`
 * （这类可选链散落在 UI 里，改默认值时极易漏改，是「设置项不生效」类 bug 的常见来源）。
 */
export class SettingsStore {
  private readonly store: JsonStore<Settings>

  constructor(userDataDir: string) {
    this.store = new JsonStore<Settings>({
      dir: userDataDir,
      fileName: 'settings.json',
      defaults: DEFAULT_SETTINGS,
      normalize: (raw, fallback) => withDefaults(raw ?? fallback)
    })
  }

  get filePath(): string {
    return this.store.filePath
  }

  get(): Settings {
    return this.store.read()
  }

  /** 局部更新：顶层字段直接替换，section 内部浅合并（保留未提及字段） */
  update(patch: SettingsPatch): Settings {
    const validated = settingsPatchSchema.parse(patch)
    return this.store.update((current) => {
      const merged = withDefaults({
        ...current,
        ...validated,
        terminal: { ...current.terminal, ...(validated.terminal ?? {}) },
        ssh: { ...current.ssh, ...(validated.ssh ?? {}) },
        sync: { ...current.sync, ...(validated.sync ?? {}) },
        ai: { ...current.ai, ...(validated.ai ?? {}) },
        security: { ...current.security, ...(validated.security ?? {}) },
        ui: { ...current.ui, ...(validated.ui ?? {}) }
      })
      return settingsSchema.parse(merged)
    })
  }

  reset(): Settings {
    return this.store.reset()
  }
}
