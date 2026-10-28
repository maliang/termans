import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ThemeDefinition } from '@shared'
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

interface ThemeCardData {
  theme: ThemeDefinition
  builtin: boolean
  background: string
  surface: string
  accent: string
  text: string
  border: string
}

export function AppearanceSettings(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const { locale, locales, setLocale } = useLocale()
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

  const [importText, setImportText] = useState('')
  const [exportText, setExportText] = useState('')

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
          value={locale}
          onChange={(event) => {
            void setLocale(event.target.value as (typeof locales)[number]['value'])
          }}
        >
          {locales.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="ts-settings__hint">{t('settings:locale.hint')}</p>
      </div>

      <div className="ts-settings__field">
        <div className="ts-settings__row">
          <span className="ts-settings__label">{t('settings:theme.label')}</span>
          <span className="ts-settings__hint" data-testid="active-theme-id">
            {activeTheme.name} · {t(`settings:theme.appearance.${activeTheme.appearance}`)}
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
                  <span className="ts-theme-card__prompt" style={{ color: card.accent }}>
                    $
                  </span>
                  <span className="ts-theme-card__line" style={{ background: card.surface }} />
                  <span className="ts-theme-card__chip" style={{ background: card.accent }} />
                </span>
                <span className="ts-theme-card__meta">
                  <span className="ts-theme-card__name">{card.theme.name}</span>
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

function toCard(theme: ThemeDefinition): ThemeCardData {
  const tokens = resolveThemeDefinition(theme)
  return {
    theme,
    builtin: isBuiltinTheme(theme),
    background: tokens['--ts-bg-app'],
    surface: tokens['--ts-bg-surface'],
    accent: tokens['--ts-accent'],
    text: tokens['--ts-text-primary'],
    border: tokens['--ts-border']
  }
}
