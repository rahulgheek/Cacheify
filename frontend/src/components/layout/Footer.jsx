/**
 * Global footer: structured product, developer, company and security links.
 * Used by the marketing page and the public information routes.
 */

import Link from 'next/link';
import Brand from '../common/Brand.jsx';
import { apiOrigin } from '../../utils/config.js';

const COLUMNS = [
  {
    title: 'Platform',
    links: [
      { label: 'Databases', href: '/databases' },
      { label: 'API keys', href: '/api-keys' },
      { label: 'Pricing', href: '/#pricing' },
      { label: 'Console', href: '/login' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { label: 'Documentation', href: '/docs' },
      { label: 'Quick start', href: '/docs/quickstart' },
      { label: 'Redis gateway', href: '/docs/redis-gateway' },
      { label: 'HTTP data plane', href: '/docs/http-data-plane' },
      { label: 'API reference', href: `${apiOrigin()}/api/openapi.json`, external: true },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'Engineering notes', href: '/blog' },
      { label: 'Create account', href: '/register' },
      { label: 'Sign in', href: '/login' },
      { label: 'Privacy policy', href: '/privacy' },
    ],
  },
  {
    title: 'Reference',
    links: [
      { label: 'Architecture', href: '/docs/architecture' },
      { label: 'TTL policy', href: '/docs/ttl-policy' },
      { label: 'Error contracts', href: '/docs/errors' },
      { label: 'FAQ', href: '/docs/faq' },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <Brand href="/" />
          <p>
            Serverless Redis with isolated databases, scoped API keys and a
            plain HTTP data plane. Free to start, no card required.
          </p>
        </div>

        {COLUMNS.map((column) => (
          <div className="footer-col" key={column.title}>
            <h3>{column.title}</h3>
            <ul>
              {column.links.map((link) => (
                <li key={`${column.title}-${link.label}`}>
                  {link.external ? (
                    <a href={link.href} target="_blank" rel="noreferrer">
                      {link.label}
                    </a>
                  ) : (
                    <Link href={link.href}>{link.label}</Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="footer-bottom">
        <p>{`\u00A9 ${new Date().getFullYear()} Cacheify. Built for builders.`}</p>
        <div className="footer-legal">
          <Link href="/privacy">Privacy</Link>
          <Link href="/docs">Documentation</Link>
          <Link href="/blog">Notes</Link>
          <a href="mailto:rahulgheek2@gmail.com?subject=Cacheify%20-%20difficulty%20or%20feedback">
            Face a difficulty? rahulgheek2@gmail.com
          </a>
        </div>
      </div>
    </footer>
  );
}
