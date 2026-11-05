'use client';

/**
 * Global top bar. On authenticated screens it pairs with the sidebar rail:
 * mobile menu toggle, brand, workspace context, docs, plan chip and account
 * controls. Public routes get the same shell with sign-in actions instead.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Brand from '../common/Brand.jsx';
import { Icon } from '../common/Icon.jsx';
import { Routes } from '../../router/routes.js';
import { useSession } from '../../hooks/index.js';
import { navigate } from '../../router/navigate.js';
import { logout } from '../../services/authService.js';

function currentSection(pathname) {
  if (pathname.startsWith('/databases/')) {
    return pathname.endsWith('/settings') ? 'Database settings' : 'Database';
  }
  if (pathname === Routes.databases) return 'Overview';
  if (pathname === Routes.apiKeys) return 'API keys';
  if (pathname === Routes.profile) return 'Profile';
  if (pathname === Routes.admin) return 'Admin';
  if (pathname === Routes.docs) return 'Documentation';
  if (pathname === Routes.privacy) return 'Privacy';
  if (pathname.startsWith(Routes.blog)) return 'Engineering notes';
  if (pathname === Routes.verify) return 'Verify email';
  if (pathname === Routes.login) return 'Sign in';
  if (pathname === Routes.register) return 'Create account';
  return '';
}

function handleLogout() {
  logout();
  navigate(Routes.login);
}

export default function Navbar({ showSidebar = false, onOpenNav = null, sidebarOpen = false }) {
  const session = useSession();
  const pathname = usePathname() || '';
  const section = currentSection(pathname);

  return (
    <header id="app-navbar" className="app-navbar">
      <div className="navbar-row">
        {showSidebar ? (
          <button
            type="button"
            className="navbar-mobile-toggle"
            aria-label={sidebarOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={sidebarOpen}
            aria-controls="app-sidebar"
            onClick={onOpenNav}
          >
            <Icon name={sidebarOpen ? 'x-lg' : 'list'} />
          </button>
        ) : null}

        <Brand href={session ? Routes.databases : '/'} />

        {session && section ? (
          <span className="navbar-context">
            <span>Console</span>
            <span aria-hidden="true">/</span>
            <strong>{section}</strong>
          </span>
        ) : null}

        <span className="navbar-status">
          <span className="dot" />
          Free platform
        </span>

        <div className="navbar-user">
          <Link href={Routes.docs} className="navbar-docs">
            <Icon name="menu-book" />
            <span>Docs</span>
          </Link>

          {session ? (
            <>
              <span className="email" title={session.user.email}>
                <span className="avatar" aria-hidden="true">
                  {(session.user.email || '?').charAt(0).toUpperCase()}
                </span>
                <span>{session.user.email}</span>
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label="Sign out"
                title="Sign out"
                data-agent-action="logout"
                onClick={handleLogout}
              >
                <Icon name="box-arrow-right" />
                <span>Sign out</span>
              </button>
            </>
          ) : (
            <>
              <Link href={Routes.login} className="btn btn-ghost">
                Sign in
              </Link>
              <Link href={Routes.register} className="btn btn-primary">
                Start for free
                <Icon name="arrow_forward" />
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
