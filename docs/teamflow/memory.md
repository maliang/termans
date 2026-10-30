# termans · TeamFlow 跨需求约定

## 约定
- **AI 供应商配置的交互基线**（20261030-r1 起）：新建供应商必须支持「未保存即读取模型列表」（草稿配置走 `ai:list-models` 的可选字段），模型必须以可点选清单呈现且保留手输入口 —— 不允许再退回「先保存再读取」或纯 `<datalist>` 自动补全。
- **默认思考强度**（20261030-r1 起）：全局单一存储位 `settings.ai.reasoningEffort`，固定三档 `low | medium | high`；三档到各协议原生参数的映射只允许存在一处实现 —— 住在 `src/shared/reasoning.ts`（渲染层与主进程共用一份），`src/main/ai/adapters.ts` 只调用它、不再写第二份数字/白名单；并由单测穷举 4 协议 × 3 档。UI 只呈现三档，不暴露 `reasoning_effort` / `budget_tokens` 等原始参数名。
- **AI 设置页的形态基线**（20261030-r2 起）：供应商配置一律「单列卡片 + 卡片内联展开编辑」（内容列 `max-width: 720px`），新增供应商走 `catalog`（预设目录）/ `custom`（手填）双模式；卡片行摘要固定为「名称 · 当前模型 · key 尾 4 位 · 默认徽标 · 凭据状态圆点 · 行尾操作（编辑/删除/设为默认）」。不允许回退成「列表 + 下方单栏表单」、弹窗编辑或左右分栏（设置内容列可用宽约 666px，双栏装不下一行摘要）。
- **设置字段新增纪律**：任何新增的 `settings.*` 字段必须同时进 `src/shared/models/settings.ts` 的 zod schema 与 `DEFAULT_SETTINGS`，否则旧 `settings.json` 会被判非法并整份回退默认值。
- **合同/验收取数纪律**：凡在验收里断言「某文案/字段不存在」，必须限定路径与结构（`git status --porcelain -- <inScope 路径>`、按解析而非子串匹配），避免共享工作树里恒红或恒绿。

## 待办（跨需求）
- 20261030-r2 验收整改（⚠️ 有条件通过）：① 已保存卡片补回 `data-testid="ai-provider-item-<id>"`（AC-12「既有 testid 不改名」，并把 `tests/contract/e2e-selectors.test.ts` 里「该前缀不存在」的自检换成虚构前缀）；② `settings.json` 的 `ai.reasoningEffort.hint`（en/zh 各 2 处）去掉 `reasoning_effort` / `thinkingConfig` 等各家参数名，UI 只呈现三档。
