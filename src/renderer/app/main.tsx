import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 全局样式必须排在 App（及其 features/*.css）之前：
// 这些文件是同名选择器（.ts-terminal / .ts-term-workspace）的后备规则，
// 一旦后注入就会把 feature 样式覆盖掉（实测 .ts-term-stack 宽度塌成 0、xterm 只剩 2×39）。
import '../styles/tokens.css'
import '../styles/base.css'
import { App } from './App'
import { initI18n, missingKeyReport, type MissingKeyInfo } from '../i18n'

/**
 * 渲染层入口。
 *
 * 顺序要求：i18n 先就绪再 mount，否则首帧会闪一遍 key（`hosts.empty.title`）再变文案，
 * 截图/录屏时非常明显。
 */
async function start(): Promise<void> {
  await initI18n()
  /**
   * 缺键报告的唯一消费者：e2e（`e2e/theme-locale.spec.ts` 切语言后断言为空）与人工排查。
   * 只读诊断数据，不含凭据；挂在 window 上是为了让被测进程外的断言够得着。
   */
  ;(window as Window & { __termansMissingKeys?: () => readonly MissingKeyInfo[] }).__termansMissingKeys =
    missingKeyReport
  const container = document.getElementById('root')
  if (!container) throw new Error('Renderer bootstrap failed: #root element not found')
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void start()
