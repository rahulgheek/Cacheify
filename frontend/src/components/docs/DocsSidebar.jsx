'use client';

/**
 * Sticky documentation sidebar: grouped topic links with the live-route
 * highlight. Desktop layout shows it as the left column; mobile collapses
 * it to a horizontal scroll strip.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '../common/Icon.jsx';
import { DOCS_PAGES, docsHref } from '../../content/docs/index.js';

const GROUPS = [
  { label: 'Getting started', slugs: ['', 'quickstart'] },
  { label: 'Connect', slugs: ['redis-gateway', 'http-data-plane'] },
  { label: 'Reference', slugs: ['architecture', 'ttl-policy', 'errors', 'faq'] },
];

function groupOf(slugs, scene) {
  return GROUPS
    .map((group) => ({
      ...group,
      pages: DOCS_PAGES.filter((page) => group.slugs.includes(page.slug || scene)),
    }))
    .filter((group) => group.pages.length);
}

export default function DocsSidebar() {
  const pathname = usePathname() || '';
  const groups = groupOf(DOCS_PAGES.map((page) => page.slug), '');

  return (
    <aside className="docs-sidebar" aria-label="Documentation topics">
      <nav className="docs-sidebar-nav">
        {groups.map((group) => (
          <div className="docs-sidebar-group" key={group.label}>
            <p>{group.label}</p>
            <ul>
              {group.pages.map((page) => {
                const href = docsHref(page);
                const active = pathname === href;
                return (
                  <li key={page.slug || 'overview'}>
                    <Link
                      href={href}
                      className={active ? 'is-active' : undefined}
                      aria-current={active ? 'page' : undefined}
                    >
                      <Icon name={page.icon} />
                      {page.nav}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
