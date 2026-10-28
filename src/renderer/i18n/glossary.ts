/**
 * SSH 术语表（中英对照的唯一事实来源）。
 *
 * - `docs/i18n.md` 里的术语表**必须与本文件逐条一致**（`tests/contract/i18n-glossary.test.ts` 会比对），
 *   避免文档与文案各写一套。
 * - `avoid` 列出同义但**不要用**的中文说法：契约测试会扫描全部 zh-CN 文案，
 *   命中即失败（例如「跳板机」不能写成「跳跃主机」「中转机」）。
 */

export interface GlossaryTerm {
  /** 稳定 id，便于测试与文档锚点 */
  id: string
  en: string
  zh: string
  /** 说明：为什么这么译、在哪些界面出现 */
  note: string
  /** 禁止使用的同类译法（中文） */
  avoid?: readonly string[]
}

export const SSH_GLOSSARY: readonly GlossaryTerm[] = [
  {
    id: 'host',
    en: 'host',
    zh: '主机',
    note: '主机库里的一条 SSH 连接配置；不要译作「服务器」（主机可以是交换机/路由器）。'
  },
  {
    id: 'host-group',
    en: 'group',
    zh: '分组',
    note: '主机库的一级归类；不用「文件夹」「分组夹」。',
    avoid: ['主机夹']
  },
  {
    id: 'host-key',
    en: 'host key',
    zh: '主机密钥',
    note: '服务器身份公钥。首次连接时展示指纹供用户确认；绝不译作「主机钥匙」。',
    avoid: ['主机钥匙', '服务器密钥']
  },
  {
    id: 'fingerprint',
    en: 'fingerprint',
    zh: '指纹',
    note: '主机密钥/客户端密钥的 SHA256 摘要，用于人工核对。',
    avoid: ['指纹码']
  },
  {
    id: 'known-hosts',
    en: 'known hosts',
    zh: '已知主机',
    note: '`known_hosts` 文件及其记录集合；保留文件名原样，界面上说「已知主机」。',
    avoid: ['已知服务器']
  },
  {
    id: 'jump-host',
    en: 'jump host',
    zh: '跳板机',
    note: 'ProxyJump 指定的中转主机；不要写「跳跃主机」「中转机」「堡垒机」（堡垒机是另一回事）。',
    avoid: ['跳跃主机', '中转机', '跳跃服务器']
  },
  {
    id: 'pty',
    en: 'PTY (pseudo-terminal)',
    zh: 'PTY（伪终端）',
    note: '`requestPTY` / `pty` 配置项；首次出现时中文写「PTY（伪终端）」，之后可直接用 PTY。',
    avoid: ['伪终端设备']
  },
  {
    id: 'snippet',
    en: 'snippet',
    zh: '命令片段',
    note: '可插入终端的常用命令模板；不要译作「代码片段」「片段」（片段单独出现时语义不明）。',
    avoid: ['代码片段', '脚本片段']
  },
  {
    id: 'private-key',
    en: 'private key',
    zh: '私钥',
    note: '本地密钥文件；一律「私钥」，不用「私有密钥」。',
    avoid: ['私有密钥']
  },
  {
    id: 'public-key',
    en: 'public key',
    zh: '公钥',
    note: '上传到服务器 authorized_keys 的那一半。',
    avoid: ['公开密钥']
  },
  {
    id: 'passphrase',
    en: 'passphrase',
    zh: '私钥口令',
    note: '加密私钥的口令；与登录用的「密码（password）」严格区分，不要都叫「密码」。',
    avoid: ['私钥密码']
  },
  {
    id: 'port-forwarding',
    en: 'port forwarding',
    zh: '端口转发',
    note: '本地/远程/动态转发统称；不要写「端口映射」。',
    avoid: ['端口映射']
  },
  {
    id: 'ssh-agent',
    en: 'SSH agent',
    zh: 'SSH 代理',
    note: '保留 SSH 前缀，不译作「代理程序」「密钥代理」。',
    avoid: ['密钥代理', '代理程序']
  },
  {
    id: 'session',
    en: 'session',
    zh: '会话',
    note: '一条已建立的 SSH 连接；不要写「连接会话」「链路」。',
    avoid: ['连接会话', '链路']
  },
  {
    id: 'tab',
    en: 'tab',
    zh: '页签',
    note: '不要把 tab 译为「标签」（标签会与 label/tag 混淆）。',
    avoid: ['标签页', '标签栏']
  },
  {
    id: 'terminal',
    en: 'terminal',
    zh: '终端',
    note: 'xterm.js 渲染的区域。'
  },
  {
    id: 'vault',
    en: 'vault',
    zh: '保险库',
    note: '存放凭据的加密容器；不要译作「仓库」「保管库」。',
    avoid: ['保管库', '保险箱']
  },
  {
    id: 'sync',
    en: 'sync',
    zh: '同步',
    note: '主机库/配置经 Git 同步；不要写「云同步」（并不依赖我们的服务器）。',
    avoid: ['云同步', '云端同步']
  },
  {
    id: 'conflict',
    en: 'conflict',
    zh: '冲突',
    note: '同步时本地与远端都改过同一处。'
  },
  {
    id: 'reconnect',
    en: 'reconnect',
    zh: '重连',
    note: '断线后自动/手动重新建立会话；不要写「重新连接」以外的变体如「重链接」。',
    avoid: ['重链接']
  },
  {
    id: 'profile',
    en: 'profile',
    zh: '配置档',
    note: '一组可复用的连接参数集合（Termius 的同名概念）；不用「配置文件」（那指文件）。',
    avoid: ['配置文件档']
  }
]

export function glossaryById(id: string): GlossaryTerm | undefined {
  return SSH_GLOSSARY.find((term) => term.id === id)
}

/** `en` 术语 → 词条，便于文档/测试反查 */
export function glossaryByEn(en: string): GlossaryTerm | undefined {
  const needle = en.trim().toLowerCase()
  return SSH_GLOSSARY.find((term) => term.en.toLowerCase() === needle)
}

/** 生成 markdown 表格行（docs/i18n.md 的术语表用它渲染，避免手抄出错） */
export function glossaryMarkdownRows(): string[] {
  return SSH_GLOSSARY.map((term) => `| ${term.en} | ${term.zh} | ${term.note} |`)
}
