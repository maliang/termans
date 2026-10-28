import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const sharedAlias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@renderer': resolve(__dirname, 'src/renderer')
}

/**
 * 生产构建注入严格 CSP；开发构建不注入。
 * 原因：@vitejs/plugin-react 的 HMR preamble 是内联 <script>，`script-src 'self'` 会直接把它拦掉，
 * 表现为 `pnpm dev` 白屏 + 控制台 "Refused to execute inline script"。
 * 因此 dev 靠 Electron 侧的安全开关（contextIsolation / sandbox / 无 nodeIntegration）兜底，
 * prod 用 CSP 收紧 + 只加载本地文件。
 */
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // xterm.js 运行时动态注入 <style>，必须放开 style 的内联
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'"
].join('; ')

function cspPlugin(): Plugin {
  let isBuild = false
  return {
    name: 'termans-csp',
    apply: () => true,
    configResolved(config) {
      isBuild = config.command === 'build'
    },
    transformIndexHtml(html) {
      if (!isBuild) return html
      return html.replace(
        '</head>',
        `    <meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />\n  </head>`
      )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // 固定开发端口：Vite 默认的 5173 在本机被别的项目常驻占用（实测是 dudu 的
    // `vite --host 127.0.0.1 --port 5173 --strictPort`），默认行为会「看起来起来了、
    // 实际窗口连的是别人的 dev server」。strictPort 让占用时立刻失败而不是悄悄换端口。
    server: { port: 5273, strictPort: true },
    plugins: [react(), cspPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
