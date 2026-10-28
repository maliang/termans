import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { THEME_TOKENS, type ThemeToken } from '@shared'
import { BUILTIN_THEMES, resolveThemeDefinition } from './builtin'
import { auditContrast } from './contrast'
import { useThemeStore } from './store'
import { TOKEN_GROUPS, isColorToken } from './tokens'
import { colorInputValue } from './validate'

/**
 * 自定义主题编辑器。
 *
 * 三个刻意的产品决定：
 * 1. **只覆盖子集**：默认继承 `extends` 指向的内置主题，改动才写入 patch；
 *    这样内置主题调整时自定义主题能跟着变，而不是被一次性快照冻住。
 * 2. **实时预览**：每次改动都立即套用到整个界面（含已打开的终端），
 *    取消时回滚到已保存的主题（`discardDraft`）。
 * 3. **对比度只警告不拦**：正文对比度 < 4.5:1 给出显式告警，但保存按钮照常可用
 *    ——用户可能就是要做一个低对比的展示主题，拦下来只是逼他绕过我们。
 */

export function ThemeEditor(): JSX.Element {
  const { t } = useTranslation(['settings', 'common', 'errors'])
  const draft = useThemeStore((state) => state.draft)
  const draftOrigin = useThemeStore((state) => state.draftOrigin)
  const previewing = useThemeStore((state) => state.previewing)
  const error = useThemeStore((state) => state.error)
  const updateDraftField = useThemeStore((state) => state.updateDraftField)
  const setDraftToken = useThemeStore((state) => state.setDraftToken)
  const resetDraftToken = useThemeStore((state) => state.resetDraftToken)
  const setPreviewing = useThemeStore((state) => state.setPreviewing)
  const discardDraft = useThemeStore((state) => state.discardDraft)
  const saveDraft = useThemeStore((state) => state.saveDraft)

  const resolved = useMemo(() => (draft ? resolveThemeDefinition(draft) : null), [draft])
  const contrast = useMemo(() => (resolved ? auditContrast(resolved) : []), [resolved])

  if (!draft || !resolved) return <section className="ts-settings__section" />

  const overrides = Object.keys(draft.tokens).length
  const bodyWarning = contrast.filter((item) => item.failsMin)

  return (
    <section className="ts-settings__section" data-testid="theme-editor">
      <div className="ts-settings__field">
        <label className="ts-settings__label" htmlFor="ts-theme-name">
          {t('settings:theme.nameLabel')}
        </label>
        <input
          id="ts-theme-name"
          className="ts-settings__input"
          data-testid="theme-name"
          value={draft.name}
          placeholder={t('settings:theme.namePlaceholder')}
          onChange={(event) => updateDraftField({ name: event.target.value })}
        />
      </div>

      <div className="ts-settings__grid2">
        <div className="ts-settings__field">
          <label className="ts-settings__label" htmlFor="ts-theme-appearance">
            {t('settings:theme.appearanceLabel')}
          </label>
          <select
            id="ts-theme-appearance"
            className="ts-settings__select"
            data-testid="theme-appearance"
            value={draft.appearance}
            onChange={(event) => updateDraftField({ appearance: event.target.value as 'dark' | 'light' })}
          >
            <option value="dark">{t('settings:theme.appearance.dark')}</option>
            <option value="light">{t('settings:theme.appearance.light')}</option>
          </select>
        </div>

        <div className="ts-settings__field">
          <label className="ts-settings__label" htmlFor="ts-theme-base">
            {t('settings:theme.baseLabel')}
          </label>
          <select
            id="ts-theme-base"
            className="ts-settings__select"
            data-testid="theme-base"
            value={draft.extends ?? BUILTIN_THEMES[0]!.id}
            onChange={(event) => updateDraftField({ extends: event.target.value })}
          >
            {BUILTIN_THEMES.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="ts-settings__row">
        <label className="ts-settings__checkbox">
          <input
            type="checkbox"
            data-testid="theme-preview-toggle"
            checked={previewing}
            onChange={(event) => setPreviewing(event.target.checked)}
          />
          {t('settings:theme.preview')}
        </label>
        <span className="ts-settings__hint" data-testid="theme-override-count">
          {t('settings:theme.tokens.covered', {
            covered: overrides,
            total: THEME_TOKENS.length,
            base: BUILTIN_THEMES.find((theme) => theme.id === draft.extends)?.name ?? BUILTIN_THEMES[0]!.name
          })}
        </span>
      </div>

      <div className="ts-contrast" data-testid="theme-contrast">
        <div className="ts-settings__row">
          <span className="ts-settings__label">{t('settings:theme.contrast.title')}</span>
          {bodyWarning.length === 0 ? (
            <span className="ts-contrast__badge ts-contrast__badge--ok">{t('settings:theme.contrast.allGood')}</span>
          ) : (
            <span className="ts-contrast__badge ts-contrast__badge--warn" data-testid="contrast-warning">
              {t('settings:theme.contrast.bodyWarning', {
                ratio: bodyWarning[0]!.ratio,
                pair: t(`settings:theme.contrast.pair.${bodyWarning[0]!.pair.id}`)
              })}
            </span>
          )}
        </div>
        <ul className="ts-contrast__list">
          {contrast.map((item) => (
            <li key={item.pair.id} className="ts-contrast__item" data-testid={`contrast-${item.pair.id}`}>
              <span className="ts-contrast__pair">{t(`settings:theme.contrast.pair.${item.pair.id}`)}</span>
              <span className="ts-contrast__swatch" style={{ background: item.background }}>
                <span style={{ color: item.foreground }}>Aa</span>
              </span>
              <span className="ts-contrast__ratio">{item.ratio}:1</span>
              <span
                className={`ts-contrast__badge ts-contrast__badge--${
                  item.failsMin ? 'fail' : item.warns ? 'warn' : 'ok'
                }`}
              >
                {t(
                  `settings:theme.contrast.${item.failsMin ? 'fail' : item.warns ? 'warn' : 'ok'}`
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {TOKEN_GROUPS.map((group) => (
        <details key={group.id} className="ts-tokens" data-testid={`token-group-${group.id}`}>
          <summary className="ts-tokens__summary">{t(`settings:theme.group.${group.id}`)}</summary>
          <div className="ts-tokens__list">
            {group.tokens.map((token) => (
              <TokenRow
                key={token}
                token={token}
                value={resolved[token]}
                overridden={token in draft.tokens}
                onChange={(value) => setDraftToken(token, value)}
                onReset={() => resetDraftToken(token)}
              />
            ))}
          </div>
        </details>
      ))}

      {error ? (
        <p className="ts-settings__error" role="alert" data-testid="theme-error">
          {t(error.key, { token: error.token ?? '', detail: error.detail ?? '' })}
        </p>
      ) : null}

      <div className="ts-settings__actions">
        <button type="button" className="ts-btn ts-btn--primary" data-testid="theme-save" onClick={() => void saveDraft()}>
          {draftOrigin === 'edit' ? t('common:action.save') : t('settings:theme.create')}
        </button>
        <button type="button" className="ts-btn ts-btn--ghost" data-testid="theme-cancel" onClick={() => discardDraft()}>
          {t('common:action.cancel')}
        </button>
      </div>
    </section>
  )
}

interface TokenRowProps {
  token: ThemeToken
  value: string
  overridden: boolean
  onChange: (value: string) => void
  onReset: () => void
}

function TokenRow({ token, value, overridden, onChange, onReset }: TokenRowProps): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const hex = isColorToken(token) ? colorInputValue(value) : null
  const name = token.replace('--ts-', '')

  return (
    <div className="ts-tokens__row" data-testid={`token-row-${name}`} data-overridden={overridden ? 'true' : 'false'}>
      <code className="ts-tokens__name">{name}</code>
      {hex ? (
        <input
          type="color"
          className="ts-tokens__color"
          data-testid={`token-color-${name}`}
          value={hex}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
      <input
        type="text"
        className="ts-tokens__input"
        data-testid={`token-input-${name}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
      <button
        type="button"
        className="ts-tokens__reset"
        data-testid={`token-reset-${name}`}
        disabled={!overridden}
        title={t('settings:theme.tokens.reset')}
        onClick={onReset}
      >
        ↺
      </button>
    </div>
  )
}
