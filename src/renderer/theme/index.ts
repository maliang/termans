/**
 * 主题模块出口。
 *
 * 这里刻意只导出**纯逻辑 + 状态**（不 import css、不 import react 组件）：
 * vitest 跑在 node 环境，`tests/contract/*.test.ts` 直接从这里取函数做断言；
 * UI 组件由 `./SettingsDialogHost` 自行引入（它带着 `./theme.css`）。
 *
 * 外部（terminal 功能、集成层）通常只需要三样：
 * - `registerXterm(term)` / `applyXtermTheme(term)`：让已打开的终端跟随主题；
 * - `useXtermTheme()`：React 组件里拿当前 xterm 配色；
 * - `applyThemeToDocument(tokens, meta)`：非 React 场景强制套用。
 */

export * from './apply'
export * from './builtin'
export * from './color'
export * from './contrast'
export * from './settings-dialog'
export * from './store'
export * from './tokens'
export * from './validate'
export * from './xterm'

export { SettingsDialogHost, SettingsButton } from './SettingsDialogHost'
export { AiSettings } from './AiSettings'
export { AppearanceSettings } from './AppearanceSettings'
export { ThemeEditor } from './ThemeEditor'
export {
  useActiveContrast,
  useActiveTheme,
  useActiveTokens,
  useThemeBootstrap,
  useThemeStorage,
  useXtermTheme
} from './hooks'
