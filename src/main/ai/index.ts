/**
 * AI 辅助（主进程）模块出口。
 *
 * 接线方式（integration 任务在 `src/main/ipc/index.ts` 里加 3 行）：
 * ```ts
 * const ai = createAiModule({ vault: vaultAdapter, userDataDir: app.getPath('userData'), getSettings: () => settingsStore.get().ai, emit: emitToAll })
 * registerAiHandlers(ai.service)
 * ```
 * `vaultAdapter` 是 t4 加密包的 4 方法适配器（`readDoc` / `writeDoc` / `deleteDoc` / `isUnlocked`）。
 */
export { AiService, AI_STREAM_SCHEMAS, StreamFrameError } from './service'
export type { AiServiceOptions, ChatExtras, EmitEvent, TestProviderResult } from './service'
export { ProviderRepository, PROVIDER_DOC_KEY, apiKeyDocKey, sanitizeHeaders } from './provider-store'
export type { ProviderRepositoryOptions, SaveProviderExtras, StoredProvider, ExtraHeaders } from './provider-store'
export { ConversationStore, deriveTitle } from './conversations'
export type { ConversationStoreOptions, RecordTurnInput } from './conversations'
export { createInMemoryAiVault, AiVaultLockedError, assertVaultUnlocked, toVaultIpcError } from './vault-port'
export type { AiVaultPort, InMemoryAiVault } from './vault-port'
export { createAiModule, registerAiHandlers, saveProviderRequestSchema, chatRequestSchema } from './ipc'
export type { AiModule, AiModuleDeps } from './ipc'
export {
  DEFAULT_CONTEXT_LINES,
  MAX_CONTEXT_LINES,
  MAX_CONTEXT_CHARS,
  SYSTEM_PROMPT_BASE,
  composeMessages,
  renderContextBlock,
  renderSystemPrompt,
  resolveContextLines,
  sanitizeTerminalOutput,
  tailLines
} from './context'
export type { ComposeMessagesInput, ContextBlockInput } from './context'
export {
  buildApiKeyRef,
  apiKeyTailFromRef,
  createRedactor,
  maskSecret,
  redact,
  registerSecret,
  MASK_PREFIX
} from './redact'
export type { Redactor } from './redact'
export {
  buildChatRequest,
  buildModelsRequest,
  createDecoder,
  interpretChunk,
  resolveStreamFormat,
  openAiUrl,
  anthropicUrl,
  geminiUrl,
  ollamaUrl,
  normalizeBaseUrl
} from './adapters'
export type { AdapterInput, BuiltRequest, InterpretedChunk, StreamFormat } from './adapters'
export { streamRequest, requestJson, AiRequestError, extractProviderErrorMessage } from './http'
export { SseDecoder, NdjsonDecoder, parseJsonPayload, isDoneSentinel } from './stream'
export type { StreamChunk, StreamDecoder } from './stream'

/* 思考强度：映射表本体只住在 @shared/reasoning（渲染层与主进程共用一份），这里只做转出口，
 * 让 AI 模块的测试与上层不必记具体路径。 */
export { resolveReasoningMode, anthropicMinMaxTokens, ANTHROPIC_MIN_MAX_TOKENS, ANTHROPIC_THINKING_BUDGET } from '@shared'
export type { ReasoningEffort, ReasoningMode, ReasoningPlan } from '@shared'
/* 读取模型失败的结构化原因（AC-3）：单测直接断言 kind/status，而不是中文整句 */
export { toListModelsFailure, parseModelIds } from './service'
export type { AiListModelsFailure, AiListModelsRequest, AiListModelsResult, AiProviderDraft } from '@shared'
