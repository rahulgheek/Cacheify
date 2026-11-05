'use client';

/**
 * Prev / next navigation rendered at the bottom of every documentation page.
 * Reads the registry, not the page itself, so ordering lives in one file.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '../common/Icon.jsx';
import { docsNeighbors, docsHref } from '../../content/docs/index.js';

export default function DocsPager({ slug }) {
  const pathname = usePathname() || '';
  const activeSlug = slug ?? (pathname.startsWith('/docs/') ? pathname.slice('/docs/'.length) : '');
  const { previous, next } = docsNeighbors(activeSlug);

  if (!previous && !next) return null;

  return (
    <nav className="docs-pager" aria-label="Adjacent documentation pages">
      {previous ? (
        <Link className="docs-pager-link is-prev" href={docsHref(previous)}>
          <Icon name="arrow-left" />
          <span>
            <small>Previous</small>
            <strong>{previous.nav}</strong>
          </span>
        </Link>
      ) : <span />}
      {next ? (
        <Link className="docs-pager-link is-next" href={docsHref(next)}>
          <span>
            <small>Next</small>
            <strong>{next.nav}</strong>
          </span>
          <Icon name="arrow-right" />
        </Link>
      ) : <span />}
    </nav>
  );
}
