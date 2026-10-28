# AI 供应商配置（Termans）

本文是 AI 辅助功能的**配置手册 + 差异对照表**。三件事说清楚：

1. 每个供应商的 baseURL / 鉴权头 / 流式格式到底差在哪（这些差异是实测出来的，不是抄文档）；
2. API key 存在哪里、怎么保证不进明文、不进日志；
3. 上下文注入、流式对话、命令生成的安全边界。

> 本文出现的所有 key 都是占位符（`sk-REPLACE_ME` 之类），**仓库里不允许出现真实 key**。
> 代码位置：主进程 `src/main/ai/**`，渲染层 `src/renderer/features/ai/**`。

---

## 1. 一分钟上手

1. 打开右侧 AI 面板 → 齿轮（供应商设置）；
2. 选择预设（OpenAI / DeepSeek / Moonshot / 通义 / OpenRouter / vLLM / LM Studio / Ollama / Anthropic / Gemini）；
3. 填 API key（本地 Ollama、vLLM、LM Studio 可留空）→ 保存；
4. 点「测试连接」——它会**真的发一次请求**（`GET /models`，Gemini 用最小 `generateContent`，Ollama 用 `/api/tags`），
   并把供应商返回的错误原文显示出来；
5. 回到对话页提问。

需要加密包（vault）已解锁：供应商配置和 key 都写在加密包里，锁定状态下
`ai:*` 通道会返回 `E_VAULT_LOCKED`（UI 显示「加密包已锁定，解锁后才能管理 AI key」）。

---

## 2. 供应商预设与真实差异

`src/renderer/features/ai/presets.ts` 里的 11 个预设：

| 预设 | kind | baseURL | 默认模型 | 鉴权头 | 流格式 |
| --- | --- | --- | --- | --- | --- |
| OpenAI | `openai` | `https://api.openai.com/v1` | `gpt-4.1-mini` | `Authorization: Bearer <key>` | SSE（OpenAI 帧） |
| DeepSeek | `openai-compatible` | `https://api.deepseek.com/v1` | `deepseek-chat` | `Authorization: Bearer <key>` | SSE（OpenAI 帧） |
| Moonshot (Kimi) | `openai-compatible` | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | `Authorization: Bearer <key>` | SSE（OpenAI 帧） |
| 通义千问 (DashScope) | `openai-compatible` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | `Authorization: Bearer <key>` | SSE（OpenAI 帧） |
| OpenRouter | `openai-compatible` | `https://openrouter.ai/api/v1` | `openai/gpt-4.1-mini` | `Authorization: Bearer <key>` + 归属头 | SSE（OpenAI 帧） |
| vLLM（自建） | `openai-compatible` | `http://127.0.0.1:8000/v1` | 取决于 `--served-model-name` | 通常无（网关要则任意占位符） | SSE（OpenAI 帧） |
| LM Studio | `openai-compatible` | `http://127.0.0.1:1234/v1` | 已加载模型 id | 无 | SSE（OpenAI 帧） |
| Ollama（原生） | `ollama` | `http://127.0.0.1:11434` | `qwen2.5-coder:7b` | 无 | **NDJSON**（`/api/chat`） |
| Anthropic | `anthropic` | `https://api.anthropic.com` | `claude-sonnet-4-20250514` | `x-api-key: <key>` + `anthropic-version: 2023-06-01` | SSE（Anthropic 事件流） |
| Gemini（默认，官方兼容端） | `openai-compatible` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | `Authorization: Bearer <key>` | SSE（OpenAI 帧） |
| Gemini（原生协议，兜底） | `openai-compatible` | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.5-flash` | `x-goog-api-key: <key>` | SSE（Gemini 帧） |

`src/shared/models/ai.ts` 里的 `AiProviderKind` 只有 `openai | anthropic | openai-compatible | ollama`
（**没有 `gemini`**）。所以 Gemini 一律按 `openai-compatible` 配置，两条路：

- **默认路（官方 OpenAI 兼容端）**：baseURL `https://generativelanguage.googleapis.com/v1beta/openai`，
  `Authorization: Bearer <key>`，OpenAI 帧。预设 `gemini` 就是这条——UI 的「供应商类型」因此
  不需要多一个枚举值，也不必改共享契约。**先用这条**。
- **兜底路（原生协议）**：baseURL `https://generativelanguage.googleapis.com/v1beta`，
  Termans 通过「host 是 `generativelanguage.googleapis.com` 且路径不含 `/openai`」自动切到
  Gemini 原生适配器（`x-goog-api-key` + `:streamGenerateContent?alt=sse`）。预设 `gemini-native` 是这条，
  只在兼容端被网关拦截、或需要原生专属字段时使用。

选哪条只看一件事：**能用兼容端就用兼容端**。原生路的存在是为了「兼容端哪天不通了不至于没法用」，
不是默认选项。

### 2.1 baseURL 的路径拼接规则

用户最容易填错的就是 baseURL。规则（`src/main/ai/adapters.ts`）：

- `openaiUrl()`：baseURL 里**已有版本段**（`/v1` `/v2` `/v1beta` 等）或含 `/openai` 时不再追加；
  否则自动补 `/v1`。所以下面三种都等价且都能用：

  | 填的 baseURL | 实际请求 |
  | --- | --- |
  | `https://api.deepseek.com` | `https://api.deepseek.com/v1/chat/completions` |
  | `https://api.deepseek.com/v1` | `https://api.deepseek.com/v1/chat/completions` |
  | `https://api.deepseek.com/v1/` | `https://api.deepseek.com/v1/chat/completions` |

- `anthropicUrl()`：baseURL 一般是 `https://api.anthropic.com`，请求 `POST /v1/messages`
  （若 baseURL 已带 `/v1` 则不重复拼）。
- `geminiUrl()`：`POST {baseURL}/models/{model}:streamGenerateContent?alt=sse`。
- `ollamaUrl()`：原生 `POST {baseURL}/api/chat`、测试连接 `GET {baseURL}/api/tags`。
  如果 `ollama` 的 baseURL 里带版本段（例如 `http://gateway.local/v1`，说明前面挂了 OpenAI 兼容反代），
  会自动切到 OpenAI 帧并请求 `/v1/chat/completions`。

### 2.2 各供应商的请求样例

**OpenAI / DeepSeek / Moonshot / 通义 / OpenRouter（OpenAI 兼容）**

```bash
curl -sS https://api.deepseek.com/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer sk-REPLACE_ME' \
  -d '{
    "model": "deepseek-chat",
    "stream": true,
    "messages": [
      { "role": "system", "content": "You are Termans AI..." },
      { "role": "user", "content": "磁盘满了怎么排查？" }
    ]
  }'
```

返回是 SSE，每帧一个 `data: {...}`，内容在 `choices[0].delta.content`：

```
data: {"choices":[{"delta":{"content":"先"}}]}

data: {"choices":[{"delta":{"content":"看 df -h"}}]}

data: [DONE]
```

差异：
- **DeepSeek `deepseek-reasoner`** 会先吐 `delta.reasoning_content`（思维链），再吐 `delta.content`。
  Termans 只累积 `content`，思维链丢弃（面板不展示，避免把中间推理当结论）。
- **Moonshot** 的上下文窗口由模型名后缀决定（`-8k/-32k/-128k`），选错会得到 400 `invalid_request_error`。
- **通义千问** 必须用 `/compatible-mode/v1` 这个入口，指向 DashScope 原生路径会 404。
- **OpenRouter** 的模型 id 是带命名空间的全名（`openai/gpt-4.1-mini`、`anthropic/claude-sonnet-4`）；
  另建议带归属头（可选，但免费额度/风控会用到）：

  ```
  HTTP-Referer: https://termans.app
  X-Title: Termans
  ```

- **token 用量**：只有 `kind=openai` 或 host 是 OpenRouter 时才发 `stream_options: {include_usage: true}`
  （部分兼容实现不认这个字段会直接 400，所以不对所有 openai-compatible 开）。

**vLLM / LM Studio（本地自建）**

```bash
curl -sS http://127.0.0.1:8000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"Qwen/Qwen2.5-Coder-7B-Instruct","stream":true,
       "messages":[{"role":"user","content":"hi"}]}'
```

- vLLM 的 `model` 必须与 `--served-model-name` 一致，否则 404 `The model ... does not exist`；
- LM Studio 先在 GUI 里加载模型，`GET /v1/models` 能列出 id；
- 两者通常不需要 key。Termans 的规则是「`kind=ollama` 之外必须有 key」，
  所以给自建网关随便填一个占位串（如 `local`）即可，它只会作为 `Authorization: Bearer local` 发出去。

**Ollama（原生 NDJSON）**

```bash
curl -sS http://127.0.0.1:11434/api/chat \
  -H 'content-type: application/json' \
  -d '{"model":"qwen2.5-coder:7b","stream":true,
       "messages":[{"role":"user","content":"hi"}],
       "options":{"temperature":0.2,"num_predict":2048}}'
```

返回**不是 SSE**，而是每行一个 JSON：

```
{"model":"qwen2.5-coder:7b","message":{"role":"assistant","content":"先"},"done":false}
{"model":"qwen2.5-coder:7b","message":{"role":"assistant","content":"看 df -h"},"done":false}
{"model":"qwen2.5-coder:7b","message":{"role":"assistant","content":""},"done":true,
 "prompt_eval_count":38,"eval_count":17}
```

差异：用量在**最后一帧**（`prompt_eval_count` / `eval_count`），`done:true` 才是结束；
`options.num_predict` 等价于 OpenAI 的 `max_tokens`。
想走 OpenAI 帧就把 baseURL 改成 `http://127.0.0.1:11434/v1`。

**Anthropic（Messages API）**

```bash
curl -sS https://api.anthropic.com/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: sk-ant-REPLACE_ME' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 2048,
    "stream": true,
    "system": "You are Termans AI...",
    "messages": [{ "role": "user", "content": "磁盘满了怎么排查？" }]
  }'
```

三个和 OpenAI 不一样的地方（都已在适配器里处理）：

1. **鉴权头是 `x-api-key`**，不是 `Authorization: Bearer`；
2. **`system` 是顶层字段**，不能塞进 `messages`（塞进去会 400）；
3. 事件流带 `event:` 名，内容在 `content_block_delta`：

```
event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":38,"output_tokens":1}}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"先看 "}}

event: message_delta
data: {"type":"message_delta","usage":{"output_tokens":42}}

event: message_stop
data: {"type":"message_stop"}
```

用量分两处：**输入 token 在 `message_start`，输出 token 在 `message_delta`**，必须合并，只看一处会显示半截用量。
`event: error` 会被识别成帧错误（例如 `overloaded_error`），不会静默当成正常结束。

**Gemini（原生 `:streamGenerateContent`）**

```bash
curl -sS 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse' \
  -H 'content-type: application/json' \
  -H 'x-goog-api-key: AIza-REPLACE_ME' \
  -d '{
    "contents": [{ "role": "user", "parts": [{ "text": "磁盘满了怎么排查？" }] }],
    "systemInstruction": { "parts": [{ "text": "You are Termans AI..." }] },
    "generationConfig": { "temperature": 0.2, "maxOutputTokens": 2048 }
  }'
```

差异：

- **key 用 `x-goog-api-key`**（也支持 `?key=`），用 Bearer 会 401 `API_KEY_INVALID`；
  这是「key 明明是对的却不通」的头号原因。
- 请求体是 `contents[].parts[].text`，assistant 角色的名字是 **`model`**；
- system 是 `systemInstruction`；
- `alt=sse` 才能拿到逐帧流（不带就是一次性 JSON 数组）；
- 有的响应是**数组包裹**（`[{...},{...}]`）而不是单个对象，解析器两种都吃；
- 用量在 `usageMetadata.promptTokenCount` / `candidatesTokenCount`。

### 2.3 自定义 baseURL / 模型 / 额外 header

三个都可以改：

- **baseURL + 模型名**：任意 OpenAI 兼容网关（LiteLLM、One-API、Azure OpenAI 反代、公司内部网关）。
- **额外 header**：供应商表单里的「额外请求头」，一行一个 `Name: value`，例如

  ```
  api-key: REPLACE_ME
  x-tenant-id: team-a
  ```

  规则（`sanitizeHeaders`，写在加密包文档里）：header 名只允许 `[A-Za-z0-9-]`，
  禁止 `host` / `content-length` / `connection` / `transfer-encoding`（它们会破坏请求），
  值总长 ≤ 2000 字符。同名 header 会覆盖内置值——这是有意的（Azure 之类需要改鉴权头），
  但也意味着**你可以用它把 `authorization` 换成别的方案**。

---

## 3. API key 的存储与脱敏

密钥模型只有一条原则：**明文只在内存里活一次，落盘一定是加密包**。

| 位置 | 内容 | 说明 |
| --- | --- | --- |
| 加密包 `ai/providers.json` | 供应商配置（id/name/kind/baseUrl/model/temperature/maxTokens/额外 header） | 不含 key |
| 加密包 `ai/api-key.<providerId>` | **明文 key** | 加密包整体加密，落盘即密文 |
| `AiProvider.apiKeyRef` | `vault:ai-key:<providerId>:<last4>` | 只是指针 + 尾号提示，UI 凭它显示 `••••abcd` |
| 日志 | `provider saved id=… hasKey=true` / `provider key updated id=… tail=abcd` | 只有尾 4 位 |
| 事件回包 / invoke 回包 | 不含 key，不含 `Authorization` 头 | 单测断言 |
| 对话历史 | **v1 只在内存**（进程内，重启即失） | 不落盘、不进 Git 同步、不进加密包（原因见 §3.1） |

脱敏（`src/main/ai/redact.ts`）作用于所有日志、错误消息与事件：

- 整串 key 精确替换（最长优先，避免一个 key 是另一个的前缀时替换出半截明文）；
- 形态匹配：`sk-…`、`sk-ant-…`、`AIza…`、`Authorization: Bearer …`、
  `api_key/apikey/access_token/secret_key` 字段值、`?key=…`（保留参数名，只掩码值）。

供应商把 key 回显在错误体里（很常见：「Incorrect API key provided: sk-…」）时，
错误事件里那句原文会被替换成 `••••abcd`，但**HTTP 状态码和错误类型保留**——
用户仍然能判断是 key 错、配额不足还是模型名错。

长什么样：

```
鉴权失败（HTTP 401）：Incorrect API key provided: ••••abcd。请检查 API key 是否正确/过期。
```

> 短于「尾号 + 掩码长度」的串会被整体掩码（否则 5 位 key 会把 4 位明文印在 UI 上）。

### 3.1 对话历史为什么不落盘

**v1 行为**：对话只保存在主进程内存（`ConversationStore` 的内存数组），当前会话内可见、
**重启即失**。`ai:list-conversations` 通道保留，但只返回**本次进程内**的会话，
不读磁盘、也没有「历史」可翻。历史对话属于「加密历史」里程碑（写进加密包或加密文件）再做。

**为什么不落盘（明文）**：聊天记录里必然出现 `user@1.2.3.4`、端口、内网路径、命令输出。
我们的安全姿态是「锁屏时不显示任何主机信息、仓库里 grep 不到 IP/密码」——把上面这些内容
明文写进 `userData/ai-conversations.json`，等于给这条姿态开一个后门，安全审查必然判红。
代价是用户重启后看不到旧对话，这是**刻意接受的**：宁可丢历史，也不让主机地址躺在磁盘上。

**老版本残留：启动即删，不迁移。** t5 首版曾用 JsonStore 把对话明文写到
`userData/ai-conversations.json`（损坏时还会生成 `ai-conversations.json.corrupt-<ts>` 备份，
同样是明文）。现在 `createAiModule({ userDataDir })` 启动时调用
`purgeLegacyConversationFiles(userDataDir)` 把它们**全部删除**，既不读取也不迁移：

- 迁移进内存只是把数据搬一遍、文件仍要删，还多一段「解析老格式」的失败路径；
- 旧格式没有版本迁移契约（写它的代码已删除），解析失败只能丢弃，不如显式丢弃；
- v1 之前的历史本来就不承诺保留。

删除是幂等的、永不抛异常（目录不存在、没有残留都返回空数组），因为启动路径不能因为清理失败
而起不来；失败只 WARN。`userDataDir` 是 `AiModuleDeps` 的可选字段，**只用于删除**，不用于存储。

将来接加密存储时改法只有一处：`ConversationStore.entries` 换成「加密后端 + 内存缓存」，
`list/get/remove/recordTurn/clear` 签名不变。`clear()` 现在就有——锁屏时可以顺手清空内存。

### 3.2 自定义请求头里的 token：与 API key 同等待遇

用户可能把鉴权放进自定义头（`x-api-key: …`、`x-tenant-token: …`、Azure 的 `api-key: …`）。
这些值和 API key 一样是凭据，所以走**完全相同的路径**：

| 环节 | 做法 |
| --- | --- |
| 落盘 | 和供应商配置写在**同一份加密包文档** `ai/providers.json`（`vault.writeDoc`），没有任何明文文件 |
| 对外视图 | `ai:list-providers` 返回的 `AiProvider` **不含 header**；只有主进程内部用 `listStored()` 取 |
| 日志 | 一行都不打。日志只有 `provider saved id=… kind=… model=… hasKey=…` 这种字段 |
| 报错 / 事件 | 请求前把 header 值登记进本次请求的 `Redactor`（`providerSecretValues()`）—— 供应商把 token 回显在错误体里时被替换成 `••••` |
| 过滤规则 | 头名像鉴权（`*-key`/`*-token`/`*-secret`/`authorization`/`cookie`/`x-api*`）一律当 secret；其它头只在值长度 ≥ 8 且不在常见非密钥白名单（`application/json` 等）时当 secret，避免把正常值掩码掉 |

验证命令（改这块前后各跑一次）：

```bash
# ① 代码层面：service.ts 里没有任何一行日志/事件带上 header
grep -rn "headers" src/main/ai/*.ts | grep -E "log\(|emit\(" || echo "OK: 无 header 进日志/事件"

# ② 行为层面：token 被回显时是否真的被掩码（含「日志 / 回包不含 token」断言）
npx vitest run tests/ai-redaction.test.ts -t "自定义请求头"
```

---

## 4. 流式对话：解析、中断、重试、用量

### 4.1 解析

`src/main/ai/stream.ts` 有三种解码器，都由 `createDecoder(format)` 按供应商选择：

| 解码器 | 用于 | 要点 |
| --- | --- | --- |
| `SseDecoder` | OpenAI 兼容 / Anthropic / Gemini | 半包粘包、`event:`/`data:` 成对、多行 `data` 用 `\n` 连接、`:` 注释忽略、CRLF/BOM 容错 |
| `NdjsonDecoder` | Ollama 原生 | 每行一个 JSON；末尾无换行的完整 JSON 不算残缺 |
| `WholeBodyDecoder` | 单个 JSON 体的网关 | 结束时一次性交付 |

两个必须做对的细节（有单测）：

- **多字节 UTF-8**：一个汉字的 3 字节可能跨两个 TCP 分片，必须用 `TextDecoder({stream:true})` 保留半字节，
  逐字节喂入也能还原出「终端上下文注入」「✅ 完成」这类内容；对每片单独 `toString()` 会出乱码。
- **异常断开**：没有结束标记就被切断时，解析器不抛异常；`incomplete` 为真且**尚未收到结束帧**时，
  上层才报「AI 响应意外中断：连接在传输完成前被切断」。已经看到 `[DONE]` / `message_stop` / `done:true`
  的尾巴残缺不算错（很多服务端省略末尾空行）。

### 4.2 中断、超时、重试

- **中断**：面板上的「停止」调用 `ai:cancel`，主进程 `AbortController.abort()`。
  已有部分内容时按「完成」收尾（保留已生成内容）；一个字都没收到时发 `ai:stream-error`「已取消生成」。
- **超时**：连接（拿到响应头）默认 20s，分片间空闲默认 30s。超时先 abort 再报错，确保连接被释放。
- **重试**：429 / 408 / 5xx 在**吐出任何字节之前**自动重试一次，退避 800ms；
  401/403/404/400 不重试（认证或参数错误重试一万次也一样）。
  重试后再失败，错误消息里会说明「已自动重试一次仍失败」。

错误文案（`describeError`）把供应商原文翻译成可操作的一句话：

| 情况 | 用户看到 |
| --- | --- |
| 401 / 403 | `鉴权失败（HTTP 401）：<原文>。请检查 API key 是否正确/过期。` |
| 404 | `接口不存在（HTTP 404）…请检查 baseURL（是否少了或多了 /v1）` |
| 429 | `请求被限流（HTTP 429）…已自动重试一次仍失败，请稍后再试。` |
| ≥500 | `供应商服务端错误（HTTP 5xx）…` |
| 超时 | `连接供应商超时（20s 无响应）。请检查网络或供应商地址后重试。` |
| 网络 | `网络请求失败：<原因>…已自动重试一次仍失败。` |

### 4.3 token 用量

面板底部显示「输入 / 输出 / 合计」。来源按供应商不同（见上表），
拿不到就是 `—`（不编 0，0 会被误读成「没花钱」）。

---

## 5. 终端上下文注入

### 5.1 注入什么

只有在**开关打开且当前有活动会话**时才注入。内容格式（主进程与渲染层预览共用同一模板）：

```
<terminal_context>
host: deploy@prod-web-1
cwd: /srv/app
os: Ubuntu 24.04
recent_output (last 200 lines, untrusted):
$ tail -n 5 /var/log/nginx/error.log
2026/01/01 10:00:00 [error] ...
</terminal_context>
```

- **行数**：默认 200 行（AI 模块常量 `DEFAULT_CONTEXT_LINES=200`），上限 500，字符上限 20000。
  实际生效值读设置 `settings.ai.contextLines`（默认 200，与模块常量一致，上限 500，面板上可改低）。
- **清洗**：剥掉 ANSI 颜色 / OSC 标题 / 其它 ESC 序列、CRLF→LF、去掉控制字符。
  否则模型会收到一堆 `\u001b[32m`，既浪费 token 又干扰理解。
- **主机信息**：`hostLabel` 由渲染层拼成 `user@host`；`os` 来自 SSH 会话拿到的系统信息（可选）；
  `cwd` 取当前会话工作目录（拿不到显示 `unknown`）。
- **只有尾部**：注入的是最近 N 行，不是全量 scrollback——全量既超 token 也可能含历史里打印过的密钥。

### 5.2 发送前必须预览

点「发送」时如果上下文已启用，会先弹「将要发送的内容」对话框，显示**完整**的 system 消息
（含 `<terminal_context>` 块），用户确认后才真正发出去。

这条不是装饰：渲染层的 `buildPreview()` 与主进程的 `composeMessages()` 用**同一套规则**，
单测直接断言两者产出的 `messages` **逐字相等**——用户确认的文本必须等于实际发出去的文本，
否则二次确认就是摆设。

---

## 6. 命令生成与执行确认

AI 回复里的 ```bash / ```sh / ```（无语言标记）代码块会被渲染成命令卡片；
```json / ```yaml 之类不会被当成命令。

三条硬规则：

1. **默认只复制**：卡片主按钮是「复制」，「执行」是次要按钮。
2. **执行要两次交互**：点「执行」→ 弹二次确认 → 确认后主进程之外的渲染层才拿到一次性执行许可
   （`CommandGuard.request() → confirm(token) → take(token)`，`take` 一次性，重复点击拿不到第二次）。
   票据 5 分钟过期——弹窗挂一晚上不能还能执行。
3. **危险命令红色告警**：二次确认对话框用危险色列出命中的原因：

| 原因 key | 触发例子 |
| --- | --- |
| `rm-recursive` | `rm -rf ./build` |
| `rm-recursive-root` | `rm -rf /`、`rm -rf ~` |
| `rm-force` | `rm -f notes.txt`（非递归但强删） |
| `disk-write` / `device-overwrite` | `dd if=/dev/zero of=/dev/sda`、`> /dev/sdb` |
| `filesystem-format` | `mkfs.ext4 /dev/sdb1` |
| `shutdown` | `shutdown -h now`、`reboot`、`systemctl poweroff` |
| `fork-bomb` | `:(){ :|:& };:` |
| `permission-wide` | `chmod -R 777 /` |
| `remote-script` | `curl … \| bash`（只算「注意」，不染红） |
| `sql-destructive` | `DROP TABLE`、`TRUNCATE TABLE`、无 `WHERE` 的 `DELETE` |

> `curl … | bash` 有意只标「注意」：它是常见安装方式，红色告警用多了会让人对红色脱敏。

**主进程永远不往终端写 AI 生成的内容**：命令写入走的是终端模块自己的 API，
AI 模块只负责「这段文字是命令」和「用户确认过了」。

---

## 7. 已知限制与契约差异

这些是当前 `src/shared` 契约的表达力限制，实现里做了兼容处理，**建议后续版本调整契约**：

1. **`AiProviderKind` 没有 `gemini`**：默认走官方 OpenAI 兼容端（`.../v1beta/openai` + Bearer），
   原生协议作为兜底预设（URL 嗅探，见 §2）；不建议为此新增枚举值。
2. **`AiProvider` 没有 `headers` 字段**：额外 header 通过 `ai:save-provider` 请求上的可选字段传入，
   存在加密包文档里，回读时经 `ProviderRepository.listStored()` 拿到（`list()` 不返回 header）。
3. **`AiTerminalContext` 没有 `os` / `username`**：`hostLabel` 拼成 `user@host`，
   `os` 通过 `ai:chat` 请求的可选扩展字段传（不在共享契约里）。
4. **上下文行数默认值**（已解决）：`DEFAULT_SETTINGS.ai.contextLines` 原为 80，与 AI 模块常量
   `DEFAULT_CONTEXT_LINES=200` 不一致；已由 architect 统一改为 **200**（契约值变更经 captain 批准），
   现在两处一致，上限仍 500，用户可在设置里调低。
5. **没有保存对话 / 提示词模板的通道**：对话 v1 **只在内存**（§3.1，重启即失，不落盘）；
   提示词模板存渲染层 `localStorage`（`termans.ai.templates.v1`，模板里没有主机信息，风险可接受）。

---

## 8. 排障对照表

| 现象 | 最可能的原因 | 怎么确认 |
| --- | --- | --- |
| 401 / `API_KEY_INVALID` | key 错、过期，或 Gemini 用了 Bearer | 「测试连接」看原文；Gemini 必须 `x-goog-api-key` |
| 404 / `model ... does not exist` | baseURL 少了/多了 `/v1`，或模型名不对 | 测试连接成功时的提示会列出可用模型名 |
| 400 `messages: roles must alternate` | 历史消息里出现连续两个同角色消息 | 新开一个对话再试 |
| 429 | 限流/额度 | 已自动重试一次；仍失败就等一会儿 |
| 一直「连接供应商超时」 | 代理/防火墙拦了 `api.*`，或 baseURL 指向内网不可达 | 命令行 `curl -sS <baseURL>/models -H 'authorization: Bearer …'` |
| Anthropic 400 `system: unexpected field` | 客户端把 system 塞进了 messages | 已在适配器里提到顶层；自建反代改过 body 则需自查 |
| Ollama 有输出但「用量 —」 | 原生 NDJSON 只在最后一帧给用量 | 正常现象，`done:true` 帧到了才有 |
| 面板显示「加密包已锁定」 | vault 未解锁 | 先解锁；AI key 与供应商配置都在加密包里 |
| 回答里命令卡片不出现 | 回复没有 ``` 代码块，或语言标记是 `json` 等非 shell | 在提示词模板里要求「用 ```bash 包住命令」 |

---

## 9. 测试覆盖

`pnpm test` 里与本模块相关的文件：

| 文件 | 覆盖 |
| --- | --- |
| `tests/ai-stream.test.ts` | SSE/NDJSON 正常流、半包（任意切分）、异常断开、多字节 UTF-8 逐字节、CRLF/BOM、各供应商帧解释与用量 |
| `tests/ai-command-guard.test.ts` | 危险命令识别（含安全命令反例）、代码块抽取、二次确认状态机（无确认拿不到许可 / token 伪造 / 过期 / 一次性） |
| `tests/ai-redaction.test.ts` | 掩码与 `apiKeyRef`、常见泄漏形态、**日志 / 事件 / 回包不含 key**、测试连接的错误原文透出 |
| `tests/ai-request.test.ts` | 各供应商 URL/鉴权头/请求体、上下文清洗与截断、**预览与主进程消息逐字一致**、429 重试 / 401 不重试 / 超时 / 取消 |
| `tests/ai-conversations.test.ts` | 会话标题、追加轮次、上限裁剪、`clear()`、**新建实例读不到旧会话（重启即失）**、chat 后磁盘上零文件、**老版本 `ai-conversations.json` 与 `.corrupt-*` 被删且不迁移**、清理幂等、不传 `userDataDir` 也可用 |
| `tests/ai-presets.test.ts` | 预设 kind 必须在契约枚举内、baseUrl 合法、默认模型在列表里；**Gemini 默认走兼容端/Bearer，原生协议只兜底** |

跑法：

```bash
pnpm test            # 全量单测（本模块 5 个文件 / 92 例）
pnpm typecheck       # 本模块相关文件无类型错误（全仓是否绿取决于其他模块进度）
```

单元测试里**没有任何真实 key**：`sk-termans-test-…` 之类的串只用于断言脱敏，
且断言方向是「输出里不含它」。

---

## 10. 接入加密包（与 t4 vault 的衔接）

AI 模块不认识 `VaultManager`，只依赖四个方法的窄接口（`src/main/ai/vault-port.ts`）：

```ts
export interface AiVaultPort {
  isUnlocked(): boolean
  readDoc(key: string): Promise<string | null>
  writeDoc(key: string, value: string): void | Promise<void>
  deleteDoc(key: string): void | Promise<void>
}
```

用到的两个 doc key：

| key | 内容 | 是否有明文风险 |
| --- | --- | --- |
| `ai/providers.json` | `{ version: 1, providers: [...] }`（含额外 header） | 无 key，但属于配置，要求同样进加密包 |
| `ai/api-key.<providerId>` | 该供应商的 API key 明文 | 靠加密包整体加密保护 |

t4 的 vault payload 里已经预留了 `integrations.aiApiKeys`（providerId → key），
但**还没有通用的「文档槽」**可以放 `ai/providers.json`，也没有对外的读写方法。
接线（t7）需要 t4 补三件事，任选其一：

**方案 A（推荐，改动最小）**：payload 的 `integrations` 里加一个字符串槽

```ts
// src/main/vault/model.ts
integrations: z.object({
  gitToken: z.string().nullable(),
  aiApiKeys: z.record(z.string(), z.string()),
  // 新增：AI 供应商配置（JSON 文本，非敏感但要求进加密包）
  aiProvidersConfig: z.string().nullable()
})
```

配一个 `VaultManager` 方法 `setAiProvidersConfig(json: string | null)` / `getAiProvidersConfig(): string | null`，
外加 `setAiApiKey / getAiApiKey / clearAiApiKey`（直接操作 `integrations.aiApiKeys`）。
之后 t7 写 20 行适配器即可：

```ts
const aiVault: AiVaultPort = {
  isUnlocked: () => vault.isUnlocked(),
  readDoc: async (key) =>
    key === PROVIDER_DOC_KEY
      ? vault.getAiProvidersConfig()
      : key.startsWith('ai/api-key.') ? vault.getAiApiKey(key.slice('ai/api-key.'.length)) : null,
  writeDoc: async (key, value) => {
    if (key === PROVIDER_DOC_KEY) vault.setAiProvidersConfig(value)
    else if (key.startsWith('ai/api-key.')) vault.setAiApiKey(key.slice('ai/api-key.'.length), value)
  },
  deleteDoc: async (key) => {
    if (key === PROVIDER_DOC_KEY) vault.setAiProvidersConfig(null)
    else if (key.startsWith('ai/api-key.')) vault.clearAiApiKey(key.slice('ai/api-key.'.length))
  }
}
```

**方案 B**：vault 直接暴露通用文档接口 `readVaultDoc(key) / writeVaultDoc(key, value) / deleteVaultDoc(key)`，
内部把这些 key 存在 payload 的新 `docs: Record<string,string>` 字段里。AI 侧不改一行。

**注意**：无论哪个方案，`AiVaultPort.isUnlocked()` 为 false 时所有 `ai:*` 通道都必须返回
`E_VAULT_LOCKED`（`toVaultIpcError` 已把 `AiVaultLockedError` 映射好），**不允许任何明文回退**——
「vault 锁定时把 key 存到 settings 里」这类兜底等于把安全设计作废。

接线位置（t7 负责，本任务不改）：

```ts
// src/main/ipc/index.ts —— 放在 installPlaceholders() 之前
const ai = createAiModule({
  vault: aiVault,                       // 上面那个适配器
  userDataDir: app.getPath('userData'), // 可选：只用于删除老版本明文对话残留（§3.1）
  getSettings: () => settingsStore.get().ai,
  emit: emitToAll
})
void ai
```

渲染层则把 `src/renderer/app/placeholders/AiPanel.tsx` 换成
`import { AiPanel } from '@renderer/features/ai'`，并传入终端侧的三个回调：

```tsx
<AiPanel
  hasSession={Boolean(activeSessionId)}
  getContext={() => terminalApi.snapshot()}       // {sessionId, hostLabel, cwd, os, recentOutput}
  getSelection={() => terminalApi.selection()}    // 选中文本 → 错误解释
  runCommand={(command, sessionId) => terminalApi.write(sessionId, command + '\n')}
/>
```
