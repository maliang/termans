/**
 * AI 辅助 feature 出口。
 *
 * 集成方式（integration 任务）：把 `src/renderer/app/placeholders/AiPanel.tsx` 换成
 *
 * ```tsx
 * import { AiPanel } from '@renderer/features/ai'
 *
 * <AiPanel
 *   hasSession={Boolean(activeSessionId)}
 *   getContext={() => terminalApi.snapshot(activeSessionId, { lines: 600 })}
 *   getSelection={() => terminalApi.selection(activeSessionId)}
 *   runCommand={(command, sessionId) => terminalApi.write(sessionId, `${command}\r`)}
 * />
 * ```
 *
 * 三个回调都由终端 feature 提供，AI 面板只「拉取」，不订阅终端 store（避免 xterm 频繁重渲染）。
 */
export { AiPanel } from './AiPanel'
export type { AiPanelProps } from './AiPanel'
export { ProviderForm } from './ProviderForm'
export type { ProviderFormProps } from './ProviderForm'
export {
  useAiStore,
  DEFAULT_TEMPLATES,
  TEMPLATE_STORAGE_KEY,
  errorMessageKey,
  loadTemplates,
  saveTemplates,
  fillTemplate
} from './store'
export type { AiState, AiView, ChatMessage, PromptTemplates, TerminalSnapshot } from './store'
export * as aiApi from './api'
export {
  PROVIDER_PRESETS,
  findPreset,
  matchPresetByBaseUrl,
  presetToInput
} from './presets'
export type { ProviderPreset } from './presets'
export {
  assessCommand,
  extractCommandBlocks,
  toSuggestion,
  CommandGuard
} from './command-guard'
export type {
  CommandAssessment,
  CommandBlock,
  ConfirmResult,
  DangerReason,
  GuardPhase,
  GuardTicket
} from './command-guard'
export { buildPreview, estimatePreviewSize, renderContextBlock, tailLines } from './prompt-preview'
export type { PreviewInput, PreviewResult } from './prompt-preview'
