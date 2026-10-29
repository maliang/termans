import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { PasteInspection } from './paste'

/**
 * 多行粘贴确认。
 *
 * 为什么必须拦一下：剪贴板里往往是「一段带换行的脚本」或「从网页复制的多行命令」，
 * 粘进终端等于逐行回车执行。用户以为只是粘贴，实际已经跑了三条命令——这是终端里
 * 最常见、也最难挽回的误操作。所以只要行数 > 1 或结尾带换行，就先问一句。
 *
 * 三个出口各有真实用途：
 * - 仍然粘贴：就是用户在终端里按 ⌘V 的本意（逐行执行）；
 * - 仅作为文本插入：把换行折成空格，只落到命令行上、不回车——想先改几处再执行时用；
 * - 取消。
 *
 * 样式用风格底座的 `.ts-dialog*`（与设置页、关闭确认框同一套弹窗语汇）。
 * 注意：`base.css` 的 `.ts-confirm` 是**行内**确认条，别拿它当模态框用。
 */

export interface PasteWarningDialogProps {
  inspection: PasteInspection
  onConfirm: () => void
  onInsertAsText: () => void
  onCancel: () => void
}

const visuallyHidden: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap'
}

export function PasteWarningDialog({
  inspection,
  onConfirm,
  onInsertAsText,
  onCancel
}: PasteWarningDialogProps): JSX.Element {
  const { t } = useTranslation()
  const preview = inspection.text.length > 400 ? `${inspection.text.slice(0, 400)}…` : inspection.text

  return (
    <div className="ts-dialog ts-tab-modal" data-testid="paste-dialog">
      <div
        className="ts-dialog__panel ts-dialog__panel--md"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="paste-dialog-title"
      >
        <header className="ts-dialog__header">
          <h2 className="ts-dialog__title" id="paste-dialog-title">
            {t('terminal:paste.warning.title', {
              lines: inspection.lineCount,
              defaultValue: 'Paste {{lines}} lines?'
            })}
          </h2>
        </header>

        <div className="ts-dialog__body">
          {/*
            * 机器可读的行数单独留一个 testid：断言不该去解析翻译串
            * （换语言就变样，而且 {{lines}} 插值后行数藏在句子中间不好取）。
            */}
          <span style={visuallyHidden} data-testid="paste-lines">
            {inspection.lineCount}
          </span>
          <p className="ts-dialog__text">
            {t('terminal:paste.warning.body', {
              defaultValue:
                'A multi-line paste runs each line as a command once the shell is ready for input.'
            })}
          </p>
          <pre className="ts-dialog__preview" data-testid="paste-preview">
            {preview}
          </pre>
        </div>

        <footer className="ts-dialog__footer ts-dialog__footer--wrap">
          <button type="button" className="ts-btn ts-btn--ghost" data-testid="paste-cancel" onClick={onCancel}>
            {t('terminal:paste.warning.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button type="button" className="ts-btn" data-testid="paste-as-text" onClick={onInsertAsText}>
            {t('terminal:paste.warning.singleLine', { defaultValue: 'Insert as text without running it' })}
          </button>
          <button
            type="button"
            className="ts-btn ts-btn--danger"
            data-testid="paste-confirm"
            onClick={onConfirm}
            autoFocus
          >
            {t('terminal:paste.warning.confirm', { defaultValue: 'Paste anyway' })}
          </button>
        </footer>
      </div>
    </div>
  )
}
