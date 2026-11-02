import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SettingsPatch, ThemeDefinition } from '@shared'
import { DEFAULT_SETTINGS } from '@shared/models/settings'
import { useShellStore } from '@renderer/app/store'
import { call, describeError } from '@renderer/platform/ipc'
import { useLocale } from '../i18n/useLocale'
import { BUILTIN_THEMES, isBuiltinTheme, resolveThemeDefinition } from './builtin'
import { useActiveTheme, useThemeStorage } from './hooks'
import { useThemeStore } from './store'

/**
 * 设置 → 外观：语言、主题选择、导入/导出、恢复默认。
 *
 * 所有交互元素都带 `data-testid`：QA 的 Playwright 断言「切主题/切语言真的生效」靠它，
 * 比按文案定位稳（文案会随语言变）。
 */

/**
 * 终端字体预设。第一项是**默认值**：`var(--ts-font-mono)` 会由主题解析成具体字体栈，
 * 所以「跟随主题」永远和当前主题的等宽字体一致。其余是常见等宽字体的字体栈，
 * 用户机器上没装也会按顺序回退，不会变成豆腐块。
 */
const FONT_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'var(--ts-font-mono)', label: '跟随主题' },
  { value: '"SF Mono", ui-monospace, Menlo, monospace', label: 'SF Mono' },
  { value: 'Menlo, Monaco, monospace', label: 'Menlo' },
  { value: 'Monaco, Menlo, monospace', label: 'Monaco' },
  { value: '"JetBrains Mono", ui-monospace, monospace', label: 'JetBrains Mono' },
  { value: '"Fira Code", ui-monospace, monospace', label: 'Fira Code' },
  { value: '"Cascadia Code", Consolas, monospace', label: 'Cascadia Code' },
  { value: 'Consolas, "Courier New", monospace', label: 'Consolas' }
]

const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 40

interface ThemeCardData {
  theme: ThemeDefinition
  builtin: boolean
  background: string
  accent: string
  text: string
  border: string
}

export function AppearanceSettings(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const { mode, locales, detected, setLocale } = useLocale()
  const storage = useThemeStorage()
  const activeTheme = useActiveTheme()

  const customThemes = useThemeStore((state) => state.customThemes)
  const activeThemeId = useThemeStore((state) => state.activeThemeId)
  const error = useThemeStore((state) => state.error)
  const savedAt = useThemeStore((state) => state.savedAt)
  const selectTheme = useThemeStore((state) => state.selectTheme)
  const beginCreate = useThemeStore((state) => state.beginCreate)
  const beginEdit = useThemeStore((state) => state.beginEdit)
  const deleteTheme = useThemeStore((state) => state.deleteTheme)
  const resetToDefault = useThemeStore((state) => state.resetToDefault)
  const importThemeFromText = useThemeStore((state) => state.importThemeFromText)
  const exportThemeToText = useThemeStore((state) => state.exportThemeToText)
  const clearError = useThemeStore((state) => state.clearError)

  const terminal = useShellStore((state) => state.settings.terminal)
  const [fontError, setFontError] = useState<string | null>(null)
  const [familyDraft, setFamilyDraft] = useState<string | null>(null)

  /**
   * 只提交 terminal 这一段：`settings:update` 是浅合并，别的段不会被覆盖；
   * 但 `ui.aiPanelVisible` 只活在内存里，所以照 AiSettings 的做法一起带上，
   * 否则「在设置里改字体」会把已展开的 AI 面板判成关闭（t47 踩过）。
   */
  const patchTerminal = useCallback(async (next: SettingsPatch): Promise<void> => {
    setFontError(null)
    try {
      const visible = useShellStore.getState().aiPanelVisible
      const updated = await call('settings:update', { ...next, ui: { aiPanelVisible: visible } })
      useShellStore.getState().setSettings(updated)
    } catch (error) {
      setFontError(describeError(error))
    }
  }, [])

  const commitFontSize = useCallback(
    (raw: number): void => {
      const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(raw)))
      if (clamped === terminal.fontSize) return
      void patchTerminal({ terminal: { fontSize: clamped } })
    },
    [patchTerminal, terminal.fontSize]
  )

  const commitFontFamily = useCallback((): void => {
    if (familyDraft === null) return
    const next = familyDraft.trim()
    setFamilyDraft(null)
    // 空值不允许（schema 是 min(1)）：回退到默认值，界面回到初始态而不是留一个空框
    const normalized = next.length > 0 ? next : DEFAULT_SETTINGS.terminal.fontFamily
    if (normalized === terminal.fontFamily) return
    void patchTerminal({ terminal: { fontFamily: normalized } })
  }, [familyDraft, patchTerminal, terminal.fontFamily])

  const [importText, setImportText] = useState('')
  const [exportText, setExportText] = useState('')
  const [dragging, setDragging] = useState(false)
  const [importedName, setImportedName] = useState('')

  /**
   * 拖放/选择文件后直接导入：读文件 → 填进粘贴框（用户看得见原文）→ 立刻导入。
   * 不做「先填框再让用户点导入」两步，否则拖放等于没省事（UI 审计 #15 的原话是门槛过高）。
   */
  const importFromFile = async (file: File): Promise<void> => {
    try {
      const text = await file.text()
      setImportText(text)
      setImportedName(file.name)
      await importThemeFromText(text)
      setImportText('')
    } catch {
      setImportedName('')
      useThemeStore.setState({ error: { key: 'settings:themeError.readFailed' } })
    }
  }

  const cards = useMemo<ThemeCardData[]>(
    () => [...BUILTIN_THEMES, ...customThemes].map(toCard),
    [customThemes]
  )

  const selectedCustom = isBuiltinTheme(activeTheme) ? null : activeTheme

  return (
    <section className="ts-settings__section" data-testid="appearance-settings">
      <div className="ts-settings__field">
        <label className="ts-settings__label" htmlFor="ts-locale-select">
          {t('settings:locale.label')}
        </label>
        <select
          id="ts-locale-select"
          className="ts-settings__select"
          data-testid="locale-select"
          value={mode}
          onChange={(event) => {
            void setLocale(event.target.value as (typeof locales)[number]['value'])
          }}
        >
          {locales.map((option) => (
            <option key={option.value} value={option.value}>
              {option.value === 'system'
                ? t('settings:locale.system', { language: t(`settings:locale.${detected}`) })
                : option.label}
            </option>
          ))}
        </select>
        <p className="ts-settings__hint" data-testid="locale-hint">
          {t('settings:locale.hint')}
        </p>
      </div>

      <div className="ts-settings__field">
        <label className="ts-settings__label" htmlFor="ts-font-family">
          {t('settings:appearance.font.family')}
        </label>
        <input
          id="ts-font-family"
          className="ts-settings__input"
          data-testid="terminal-font-family"
          list="ts-font-presets"
          spellCheck={false}
          value={familyDraft ?? terminal.fontFamily}
          onChange={(event) => setFamilyDraft(event.target.value)}
          onBlur={() => commitFontFamily()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitFontFamily()
            if (event.key === 'Escape') setFamilyDraft(null)
          }}
        />
        <datalist id="ts-font-presets">
          {FONT_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </datalist>
        <p className="ts-settings__hint">{t('settings:appearance.font.familyHint')}</p>
      </div>

      <div className="ts-settings__field">
        <div className="ts-settings__row">
          <label className="ts-settings__label" htmlFor="ts-font-size">
            {t('settings:appearance.font.size')}
          </label>
          <div className="ts-settings__stepper">
            <button
              type="button"
              className="ts-btn ts-btn--ghost ts-btn--icon"
              data-testid="terminal-font-size-dec"
              disabled={terminal.fontSize <= FONT_SIZE_MIN}
              onClick={() => commitFontSize(terminal.fontSize - 1)}
              aria-label={t('settings:appearance.font.decrease')}
            >
              −
            </button>
            <input
              id="ts-font-size"
              className="ts-settings__input ts-settings__input--num"
              data-testid="terminal-font-size"
              type="number"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              step={1}
              value={terminal.fontSize}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10)
                if (!Number.isNaN(parsed)) commitFontSize(parsed)
              }}
            />
            <button
              type="button"
              className="ts-btn ts-btn--ghost ts-btn--icon"
              data-testid="terminal-font-size-inc"
              disabled={terminal.fontSize >= FONT_SIZE_MAX}
              onClick={() => commitFontSize(terminal.fontSize + 1)}
              aria-label={t('settings:appearance.font.increase')}
            >
              +
            </button>
          </div>
        </div>
        <p className="ts-settings__hint">{t('settings:appearance.font.sizeHint')}</p>
        <div
          className="ts-term-font-preview"
          data-testid="terminal-font-preview"
          style={{
            fontFamily: terminal.fontFamily,
            fontSize: `${terminal.fontSize}px`
          }}
        >
          {t('settings:appearance.font.previewText')}
        </div>
        {fontError !== null ? (
          <p className="ts-settings__error" role="alert" data-testid="terminal-font-error">
            {fontError}
          </p>
        ) : null}
      </div>

      <div className="ts-settings__field">
        <div className="ts-settings__row">
          <span className="ts-settings__label">{t('settings:theme.label')}</span>
          <span className="ts-settings__hint" data-testid="active-theme-id">
            {isBuiltinTheme(activeTheme)
              ? t(`settings:theme.builtinName.${activeTheme.id}`)
              : activeTheme.name}
          </span>
        </div>

        <div className="ts-theme-grid" data-testid="theme-grid" role="listbox" aria-label={t('settings:theme.label')}>
          {cards.map((card) => {
            const active = card.theme.id === activeThemeId
            return (
              <button
                key={card.theme.id}
                type="button"
                role="option"
                aria-selected={active}
                data-testid={`theme-option-${card.theme.id}`}
                data-active={active ? 'true' : 'false'}
                className={`ts-theme-card${active ? ' ts-theme-card--active' : ''}`}
                onClick={() => {
                  clearError()
                  void selectTheme(card.theme.id)
                }}
              >
                <span
                  className="ts-theme-card__preview"
                  style={{ background: card.background, borderColor: card.border, color: card.text }}
                >
                  <ThemeMark color={card.accent} />
                  {/* 两行「文字」而不是一块色条：色条读起来像进度条，看不出这是个终端 */}
                  <span
                    className="ts-theme-card__line"
                    style={{ background: card.text, opacity: 0.55 }}
                  />
                  <span
                    className="ts-theme-card__line ts-theme-card__line--short"
                    style={{ background: card.text, opacity: 0.28 }}
                  />
                  <span className="ts-theme-card__chip" style={{ background: card.accent }} />
                </span>
                <span className="ts-theme-card__meta">
                  <span className="ts-theme-card__name">{cardLabel(card, t)}</span>
                  <span className="ts-theme-card__badge">
                    {card.builtin ? t('settings:theme.builtin') : t('settings:theme.custom')}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="ts-settings__actions">
          <button type="button" className="ts-btn" data-testid="theme-create" onClick={() => beginCreate()}>
            {t('settings:theme.create')}
          </button>
          <button
            type="button"
            className="ts-btn ts-btn--ghost"
            data-testid="theme-reset"
            onClick={() => void resetToDefault()}
          >
            {t('settings:theme.reset')}
          </button>
        </div>

        {selectedCustom ? (
          <div className="ts-settings__actions">
            <button
              type="button"
              className="ts-btn ts-btn--ghost"
              data-testid="theme-edit"
              onClick={() => beginEdit(selectedCustom.id)}
            >
              {t('settings:theme.edit')}
            </button>
            <button
              type="button"
              className="ts-btn ts-btn--ghost"
              data-testid="theme-delete"
              onClick={() => {
                if (window.confirm(t('settings:theme.deleteConfirm', { name: selectedCustom.name }))) {
                  void deleteTheme(selectedCustom.id)
                }
              }}
            >
              {t('settings:theme.delete')}
            </button>
            <button
              type="button"
              className="ts-btn ts-btn--ghost"
              data-testid="theme-export"
              onClick={() => setExportText(exportThemeToText(selectedCustom.id) ?? '')}
            >
              {t('settings:theme.export')}
            </button>
          </div>
        ) : null}

        {storage !== 'ipc' ? (
          <p className="ts-settings__warning" data-testid="theme-storage-warning">
            {t(`settings:theme.storage.${storage}`)}
          </p>
        ) : null}

        {error ? (
          <p className="ts-settings__error" role="alert" data-testid="theme-error">
            {t(error.key, { token: error.token ?? '', detail: error.detail ?? '' })}
          </p>
        ) : null}

        {savedAt ? (
          <p className="ts-settings__hint" data-testid="theme-saved-at">
            {t('settings:theme.savedAt', { time: savedAt })}
          </p>
        ) : null}
      </div>

      <div className="ts-settings__field">
        <label className="ts-settings__label" htmlFor="ts-theme-import">
          {t('settings:theme.import')}
        </label>

        {/* v13 的导入只有粘贴框：卖点功能门槛过高（UI 审计 #15）。文件选择与拖放都走
            input[type=file] / dataTransfer，读文本只在渲染进程完成，不新增 IPC 契约。 */}
        <div
          className={`ts-dropzone${dragging ? ' ts-dropzone--active' : ''}`}
          data-testid="theme-import-drop"
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            const file = event.dataTransfer.files?.[0]
            if (file) void importFromFile(file)
          }}
        >
          <p className="ts-dropzone__title">{t('settings:theme.importDrop')}</p>
          <label className="ts-btn" htmlFor="ts-theme-import-file">
            {t('settings:theme.importFile')}
            <input
              id="ts-theme-import-file"
              className="ts-visually-hidden"
              type="file"
              accept="application/json,.json"
              data-testid="theme-import-file"
              onChange={(event) => {
                const file = event.target.files?.[0]
                // 清空 value：同一个文件连续选两次也要能触发 change
                event.target.value = ''
                if (file) void importFromFile(file)
              }}
            />
          </label>
          <p className="ts-dropzone__hint">{t('settings:theme.importDropHint')}</p>
          {importedName ? (
            <p className="ts-dropzone__hint" data-testid="theme-import-file-name">
              {t('settings:theme.importedFrom', { name: importedName })}
            </p>
          ) : null}
        </div>

        <textarea
          id="ts-theme-import"
          className="ts-settings__textarea"
          data-testid="theme-import-text"
          rows={4}
          placeholder={t('settings:theme.importPlaceholder')}
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
        />
        <div className="ts-settings__actions">
          <button
            type="button"
            className="ts-btn"
            data-testid="theme-import"
            disabled={importText.trim() === ''}
            onClick={() => {
              void importThemeFromText(importText)
              setImportText('')
            }}
          >
            {t('settings:theme.importAction')}
          </button>
        </div>
        {exportText ? (
          <>
            <p className="ts-settings__hint">{t('settings:theme.exportHint')}</p>
            <textarea
              className="ts-settings__textarea"
              data-testid="theme-export-text"
              rows={6}
              readOnly
              value={exportText}
            />
          </>
        ) : null}
      </div>
    </section>
  )
}

/**
 * 品牌标记 `>_`（内联 SVG，不引依赖、不用字体图标）。
 *
 * 主题卡缩略图原先画的是 `$`，与产品标识 `>_` 不一致（UI 审计 #14）；
 * 这里用纯路径重画，颜色由调用方用 accent 传进来，因此四张卡各自跟着自己的主题色。
 */
function ThemeMark({ color }: { color: string }): JSX.Element {
  return (
    <svg className="ts-theme-card__mark" viewBox="0 0 22 12" role="presentation" aria-hidden="true">
      <g fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.2 2.4 7.3 6 2.2 9.6" />
        <path d="M10.4 9.7h9.4" />
      </g>
    </svg>
  )
}

/** 内置主题名要本地化（中文「Termans 深色」），自定义主题保留用户自己起的名字 */
function cardLabel(card: ThemeCardData, t: (key: string) => string): string {
  return card.builtin ? t(`settings:theme.builtinName.${card.theme.id}`) : card.theme.name
}

function toCard(theme: ThemeDefinition): ThemeCardData {
  const tokens = resolveThemeDefinition(theme)
  return {
    theme,
    builtin: isBuiltinTheme(theme),
    background: tokens['--ts-bg-app'],
    accent: tokens['--ts-accent'],
    text: tokens['--ts-text-primary'],
    border: tokens['--ts-border']
  }
}
