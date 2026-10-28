import { useTranslation } from 'react-i18next'
import { FolderPlus, Import, Lock, Plus, Search, Server, Settings } from 'lucide-react'
import { useShellStore } from '../store'
import { BrandMark } from './BrandMark'

/**
 * 左侧主机库（占位骨架）。
 *
 * 归属：vault-sync 提供主机/分组数据与 CRUD，integration 在 App.tsx 里替换本组件。
 * 这里只锁死「布局与交互位置」：品牌区 / 搜索 / 新建与导入 / 主机树 / 底部锁与设置。
 */
export function HostSidebar(): JSX.Element {
  const { t } = useTranslation(['hosts', 'common'])
  const settings = useShellStore((state) => state.settings)
  const setPreviewLocked = useShellStore((state) => state.setPreviewLocked)

  return (
    <aside className="ts-sidebar" data-testid="host-sidebar" aria-label={t('hosts:sidebar.title')}>
      <div className="ts-sidebar__brand">
        <BrandMark />
        <div className="ts-sidebar__brand-text">
          <span className="ts-sidebar__brand-name">{t('common:app.name')}</span>
          <span className="ts-sidebar__brand-tagline">{t('common:app.tagline')}</span>
        </div>
      </div>

      <div className="ts-sidebar__search">
        <Search size={14} aria-hidden="true" />
        <input type="search" placeholder={t('hosts:sidebar.search')} aria-label={t('hosts:sidebar.search')} />
      </div>

      <div className="ts-sidebar__actions">
        <button type="button" className="ts-btn ts-btn--primary" title={t('hosts:action.new')}>
          <Plus size={14} aria-hidden="true" />
          {t('hosts:action.new')}
        </button>
        <button type="button" className="ts-btn" title={t('hosts:action.import')}>
          <Import size={14} aria-hidden="true" />
          {t('hosts:action.import')}
        </button>
        <button type="button" className="ts-btn ts-btn--ghost" title={t('hosts:action.newGroup')}>
          <FolderPlus size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="ts-sidebar__tree" data-testid="host-tree">
        <div className="ts-empty ts-empty--compact">
          <Server size={20} aria-hidden="true" />
          <p className="ts-empty__title">{t('hosts:empty.title')}</p>
          <p className="ts-empty__body">{t('hosts:empty.body')}</p>
        </div>
      </div>

      <div className="ts-sidebar__footer">
        <button
          type="button"
          className="ts-btn ts-btn--ghost"
          onClick={() => setPreviewLocked(true)}
          title={t('common:action.lock')}
        >
          <Lock size={14} aria-hidden="true" />
          {t('common:action.lock')}
        </button>
        <button type="button" className="ts-btn ts-btn--ghost" title={t('common:action.settings')}>
          <Settings size={14} aria-hidden="true" />
        </button>
        <span className="ts-sidebar__locale">{settings.locale}</span>
      </div>
    </aside>
  )
}
