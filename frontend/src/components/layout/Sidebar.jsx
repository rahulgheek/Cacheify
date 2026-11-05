'use client';

/**
 * Authenticated console navigation. Desktop shows a sticky rail beneath the
 * top bar; mobile turns it into an off-canvas drawer owned by AuthGate.
 */

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { Icon } from '../common/Icon.jsx';
import { LogoMark } from '../common/Brand.jsx';
import { useSession } from '../../hooks/index.js';
import { Routes } from '../../router/routes.js';

function isCurrent(pathname, href) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function Sidebar({ open = false, onNavigate = () => {} }) {
  const session = useSession();
  const pathname = usePathname() || '';
  const closeButtonRef = useRef(null);

  useEffect(() => {
    if (open && typeof window !== 'undefined' && window.matchMedia('(max-width: 960px)').matches) {
      closeButtonRef.current?.focus();
    }
  }, [open]);

  const workspace = [
    { href: Routes.databases, label: 'Overview', icon: 'grid-1x2' },
    { href: Routes.apiKeys, label: 'API keys', icon: 'key' },
    { href: Routes.profile, label: 'Profile', icon: 'person-circle' },
    ...(session && session.user.role === 'admin'
      ? [{ href: Routes.admin, label: 'Admin', icon: 'people' }]
      : []),
  ];

  const resources = [
    { href: Routes.docs, label: 'Documentation', icon: 'menu-book' },
    { href: Routes.privacy, label: 'Privacy', icon: 'shield-lock' },
  ];

  return (
    <aside
      className={`app-sidebar${open ? ' is-open' : ''}`}
      id="app-sidebar"
      aria-label="Console navigation"
    >
      <div className="sidebar-inner">
        <div className="sidebar-mobile-head">
          <LogoMark />
          <span style={{ fontWeight: 700, letterSpacing: '-0.03em' }}>Cacheify</span>
          <button type="button" className="sidebar-close" ref={closeButtonRef} aria-label="Close navigation" onClick={onNavigate}>
            <Icon name="x-lg" />
          </button>
        </div>

        <div className="sidebar-group">
          <p className="sidebar-heading">Workspace</p>
          {workspace.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="sidebar-link"
              aria-current={isCurrent(pathname, item.href) ? 'page' : undefined}
              onClick={onNavigate}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          ))}
        </div>

        <div className="sidebar-group">
          <p className="sidebar-heading">Resources</p>
          {resources.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="sidebar-link"
              aria-current={isCurrent(pathname, item.href) ? 'page' : undefined}
              onClick={onNavigate}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          ))}
        </div>

        <div className="sidebar-foot">
          <div className="sidebar-plan">
            <p className="sidebar-plan-label">Current plan</p>
            <p className="sidebar-plan-title">Free, for everyone</p>
            <p>5 isolated databases, scoped keys and the full data plane.</p>
            <Link href="/#pricing" onClick={onNavigate}>
              See what is included
              <Icon name="arrow_forward" />
            </Link>
          </div>
        </div>
      </div>
    </aside>
  );
}
