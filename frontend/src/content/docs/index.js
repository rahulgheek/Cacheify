/**
 * Docs registry: single source of truth for the documentation section.
 * Consumed by the /docs layout (sidebar), the pager (prev/next) and every
 * nav reference (navbar, footer, landing CTAs) so links never drift.
 */

export const DOCS_SECTION = '/docs';

export const DOCS_PAGES = [
  {
    slug: '',
    title: 'Overview',
    nav: 'Overview',
    icon: 'info-circle',
    lede: 'What Cacheify is and the one line that connects your app.',
  },
  {
    slug: 'quickstart',
    title: 'Quick start',
    nav: 'Quick start',
    icon: 'rocket_launch',
    lede: 'From sign-up to a first successful request in four steps.',
  },
  {
    slug: 'redis-gateway',
    title: 'Redis gateway',
    nav: 'Redis gateway',
    icon: 'cable',
    lede: 'Connect native Redis clients over the RESP protocol.',
  },
  {
    slug: 'http-data-plane',
    title: 'HTTP data plane',
    nav: 'HTTP data plane (advanced)',
    icon: 'terminal',
    lede: 'Advanced: the JSON-over-HTTPS API behind the gateway.',
  },
  {
    slug: 'architecture',
    title: 'Architecture',
    nav: 'Architecture',
    icon: 'diagram-3',
    lede: 'The request path, tenant isolation and operator modes.',
  },
  {
    slug: 'ttl-policy',
    title: 'TTL policy',
    nav: 'TTL policy',
    icon: 'clock',
    lede: 'Mandatory expiry on every key, by design.',
  },
  {
    slug: 'errors',
    title: 'Errors',
    nav: 'Errors',
    icon: 'shield-exclamation',
    lede: 'Status codes, error codes and how to retry safely.',
  },
  {
    slug: 'faq',
    title: 'FAQ',
    nav: 'FAQ',
    icon: 'question-circle',
    lede: 'Short answers to the questions we hear most.',
  },
];

export function docsHref(page) {
  return page && page.slug ? `${DOCS_SECTION}/${page.slug}` : DOCS_SECTION;
}

/** Prev/next triple for the pager at the bottom of every docs page. */
export function docsNeighbors(slug) {
  const index = DOCS_PAGES.findIndex((p) => p.slug === (slug || ''));
  const previous = index > 0 ? DOCS_PAGES[index - 1] : null;
  const next = index !== -1 && index < DOCS_PAGES.length - 1 ? DOCS_PAGES[index + 1] : null;
  return { current: DOCS_PAGES[index] || null, previous, next };
}
