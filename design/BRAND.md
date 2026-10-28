# Termans · 品牌与图标规范

> 这篇是 t1（架构/契约）与 t9（打包/文档）的输入。改颜色、改图标前先看这里，不要在各处另定一套。

## 1. 标志

**`>_`**：终端提示符（chevron + 下划线光标），单一琥珀色，深墨蓝圆角方底。没有渐变、没有发光、没有多余元素。

- 语义：`>` = 提示符 / 连接方向；`_` = 光标 / 同步落点。一个标只讲一件事：终端。
- 手绘规则：两臂严格对称、圆头圆角，臂斜率固定 `dy/dx = 0.727`（约 36°，`dx = dy × 1.376`）。
- **下划线必须与 chevron 错开**：放在尖端右侧、底缘同高，不压在 chevron 正下方。原因有两条——压在正下方时下臂是斜的、其下缘与下划线左端只隔约 2 px，24 px 以下会连成一块，整标读起来像字母 Z；错开之后 16 px 依然认得出来是 `>_`。
- 定位三式（1024 画布，先算图形再整体居中）：
  1. 下划线右缘 = `vx + sw/2 + gap + bar_w`
  2. 下划线的**底缘与 chevron 底缘同高**（`cb + sw/2`）
  3. 整组按包围盒（`ex-sw/2 … 下划线右缘` × `chevron 顶 … 下划线底`）居中到 512,512——三档的垂直偏移都自然为 0，水平偏移约 −124 / −138 / −151
- 三档光学尺寸（同一形状、同一斜率，只调粗细与间距）：

| 档位 | 用处 | chevron 端点 x / y | stroke | 下划线 w×h | gap | 包围盒 |
|---|---|---|---|---|---|---|
| `termans-icon.svg` | ≥ 48 px | 401.9 / 352–672 | 100 | 236×100 | 12 | 568×420 |
| `termans-icon-small.svg` | 24–32 px | 390.9 / 336–688 | 118 | 260×118 | 16 | 636×470 |
| `termans-icon-micro.svg` | 16–22 px | 379.9 / 320–704 | 136 | 280×136 | 22 | 702×520 |
| `termans-mark-mono.svg` | 托盘 / 菜单栏 / favicon（纯黑 + alpha，无底板） | 同 micro | 136 | 280×136 | 22 | 702×520 |

小尺寸为什么必须单独一档：同一张图直接缩到 16 px，chevron 只剩 1.6 px、笔画与下划线糊成一坨（已用 7–10× 像素放大核对）。

## 2. 色彩 token（t1 落成 CSS 变量；主题任务只换值，不改结构）

| token | 值 | 用途 |
|---|---|---|
| `--ts-ink-900` | `#05080E` | 应用最底层背景 |
| `--ts-ink-800` | `#0D1424` | 面板 / 图标底板 |
| `--ts-ink-700` | `#1C2746` | 浮层、选中态描边 |
| `--ts-amber` | `#F8AB24` | 唯一强调色：提示符、主按钮、焦点环、图标 |
| `--ts-amber-soft` | `#FFE2A8` | 琥珀上的高光文字 / hover |
| `--ts-amber-deep` | `#C86A08` | 按下态、暗底分隔 |
| `--ts-mint` | `#1D9663` | 状态色：已连接、同步成功 |
| `--ts-danger` | `#E0553B` | 断开、错误 |

约定：琥珀管「动作」，薄荷管「状态」，红色只管「出错」；不要用薄荷做按钮主色，不要用琥珀表示已连接。终端 ANSI 16 色按同一色温校准（绿取 mint 系、黄取 amber 系）。

## 3. 资产

- 矢量：`logo/termans-icon.svg`、`logo/termans-icon-small.svg`、`logo/termans-icon-micro.svg`、`logo/termans-mark-mono.svg`、`logo/termans-lockup.svg`（深底）、`logo/termans-lockup-light.svg`（浅底）
- 位图：`logo/export/` —— icon 48/64/128/256/512/1024、small 24/32、micro 16/22、mono 16/22/32、lockup 两版、`termans.icns`、`termans.ico`
- 打包直接可用：仓库根 `build/icon.png`(1024)、`build/icon.icns`（10 个尺寸，`iconutil` 反向解包验过）、`build/icon.ico`（16/24/32/48/64/128/256 七档，16/24 用 micro & small 档位而非硬缩）
- 验收图：`logo/preview/tiers.png`（真尺寸阶梯 + 5–9× 像素放大 + 托盘 + 字标）
- 被否方向留在 `logo/archive/`，不要再拿出来用。

## 4. 字标

- 软件名固定 `Termans`；副标固定 `SSH · SYNC · AI`（英文大写、字距 +0.27em）；中文文案里软件名不翻译。
- README / 关于窗口用 lockup；应用内标题直接用 UI 字体排版，不要把 lockup 当界面元素拉伸。
- lockup 的文字取自系统字体栈（Inter → SF Pro → Segoe UI），换机器会有 1–2 px 差异，属正常。
