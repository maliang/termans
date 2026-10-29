import { defineConfig } from '@playwright/test'

/**
 * Playwright-Electron：直接驱动 `out/main/index.js`（构建产物），**不启动 Vite dev server**。
 * qa 只在本目录（e2e/）下扩写用例；新增用例前必须 `pnpm build`（`pnpm test:e2e` 已内置）。
 */
export default defineConfig({
  testDir: './e2e',
  // 产物新鲜度闸门：`npx playwright test` 不 build，拿旧产物跑出来的红是「上一版界面」的红
  // （2026-10-29 因此误判过 dual-machine 三条）。宁可 2 秒红得明白，也别 30 秒超时误导人。
  globalSetup: './e2e/global-setup.ts',
  // 安全带，不是许可：`e2e/` 禁止留一次性脚本（规则见 docs/TESTING.md §6）。但同一天里出现过 4 个
  // 别人的 `zz-*-shots.spec.ts` 截图脚本，它们会被 testDir 当成正式用例执行、把整套 e2e 拖红，
  // 所以在配置层再兜一道。真要留脚本请放 `scripts/shots/` 或仓库外 `/tmp`。
  testIgnore: ['**/zz-*'],
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
