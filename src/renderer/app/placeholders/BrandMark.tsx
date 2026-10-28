/**
 * 品牌标记（占位骨架版，几何比例来自 design/BRAND.md：36° 琥珀色 `>` 折线 + 短横）。
 * theme-i18n 接入完整 logo 资源后可替换本组件；这里内联 SVG 是为了首屏不依赖外部文件。
 */
export function BrandMark({ size = 26 }: { size?: number }): JSX.Element {
  return (
    <svg
      className="ts-brand-mark"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="Termans"
    >
      <rect x="0" y="0" width="48" height="48" rx="11" fill="var(--ts-ink-800)" />
      <path
        d="M14.5 14.5 L27 24 L14.5 33.5"
        fill="none"
        stroke="var(--ts-amber)"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M29.5 33.5 H37" stroke="var(--ts-amber-soft)" strokeWidth="4.5" strokeLinecap="round" />
    </svg>
  )
}
