import { defineConfig } from '@playwright/test'

/**
 * Playwright-Electron：直接驱动 `out/main/index.js`（构建产物），**不启动 Vite dev server**。
 * qa 只在本目录（e2e/）下扩写用例；新增用例前必须 `pnpm build`（`pnpm test:e2e` 已内置）。
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './artifacts/playwright',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Electron 启动会抢同一份 userData，串行跑避免互相踩
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
})
