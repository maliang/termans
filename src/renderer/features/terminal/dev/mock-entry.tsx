import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '../../../i18n'
import '../../../styles/tokens.css'
import '../../../styles/base.css'
import { applyThemeToDocument, BUILTIN_THEMES, resolveThemeDefinition } from '../../../theme'
import { MockWorkspace } from './MockWorkspace'

/**
 * mock 页面的入口：初始化 i18n → 挂载 `MockWorkspace`。
 *
 * 只被 `mock.html` 引用（dev server 下 `/features/terminal/dev/mock.html`），
 * 生产构建的入口仍然是 `index.html → main.tsx → App`，所以这条路径不会进产物。
 */

declare global {
  interface Window {
    /** e2e 用它等「第一帧终端已经挂上」 */
    __termansMockReady?: boolean
    /** e2e：套用内置主题（走主题模块的正规入口，终端由 registerXterm 跟随重绘） */
    __termansMockApplyTheme?: (themeId: string) => string
  }
}

async function boot(): Promise<void> {
  await initI18n()
  const container = document.getElementById('root')
  if (!container) throw new Error('缺少 #root 容器')
  createRoot(container).render(
    <StrictMode>
      <MockWorkspace />
    </StrictMode>
  )
  window.__termansMockApplyTheme = (themeId: string): string => {
    const theme = BUILTIN_THEMES.find((candidate) => candidate.id === themeId)
    if (!theme) throw new Error(`未知主题：${themeId}`)
    applyThemeToDocument(resolveThemeDefinition(theme), { id: theme.id, appearance: theme.appearance })
    return theme.id
  }
  window.__termansMockReady = true
}

void boot()
