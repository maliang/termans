import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initI18n } from '../i18n'
import '../styles/tokens.css'
import '../styles/base.css'

/**
 * 渲染层入口。
 *
 * 顺序要求：i18n 先就绪再 mount，否则首帧会闪一遍 key（`hosts.empty.title`）再变文案，
 * 截图/录屏时非常明显。
 */
async function start(): Promise<void> {
  await initI18n()
  const container = document.getElementById('root')
  if (!container) throw new Error('Renderer bootstrap failed: #root element not found')
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void start()
