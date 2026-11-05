'use client';

/**
 * Marketing navigation: product/developer dropdowns, direct links, signed-out
 * actions and a mobile drawer. Keyboard support: Enter/Space to open,
 * ArrowDown to enter the menu, Escape to close and restore focus.
 */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import Brand from '../../common/Brand.jsx';
import { Icon } from '../../common/Icon.jsx';
import { apiOrigin } from '../../../utils/config.js';

const PRODUCT = [
  {
    label: 'Serverless Redis',
    description: 'What it is and how requests flow.',
    href: '/docs/architecture',
    icon: 'database',
  },
  {
    label: 'RESP gateway',
    description: 'Connect Redis clients as if nothing changed.',
    href: '/docs/redis-gateway',
    icon: 'cable',
  },
  {
    label: 'HTTP data plane',
    description: 'Advanced reference: the JSON layer behind the gateway.',
    href: '/docs/http-data-plane',
    icon: 'terminal',
  },
  {
    label: 'TTL policy',
    description: 'Mandatory expiry on every key.',
    href: '/docs/ttl-policy',
    icon: 'clock',
  },
];

const DEVELOPERS = [
  {
    label: 'Documentation',
    description: 'The full doc index, split by topic.',
    href: '/docs',
    icon: 'menu-book',
  },
  {
    label: 'Quick start',
    description: 'First database and first command.',
    href: '/docs/quickstart',
    icon: 'rocket_launch',
  },
  {
    label: 'Errors',
    description: 'Status codes and retry rules.',
    href: '/docs/errors',
    icon: 'shield-exclamation',
  },
  {
    label: 'API reference',
    description: 'The machine-readable OpenAPI 3.1 contract.',
    href: `${apiOrigin()}/api/openapi.json`,
    icon: 'braces',
    external: true,
  },
  {
    label: 'Agent index',
    description: 'llms.txt for coding assistants and agents.',
    href: `${apiOrigin()}/llms.txt`,
    icon: 'robot',
    external: true,
  },
];

function MenuItem({ item, onNavigate }) {
  const content = (
    <>
      <span className="nav-menu-icon" aria-hidden="true"><Icon name={item.icon} /></span>
      <span>
        <strong>{item.label}</strong>
        <small>{item.description}</small>
      </span>
    </>
  );

  if (item.external) {
    return (
      <a href={item.href} role="menuitem" target="_blank" rel="noreferrer" onClick={onNavigate}>
        {content}
      </a>
    );
  }
  return (
    <Link href={item.href} role="menuitem" onClick={onNavigate}>
      {content}
    </Link>
  );
}

function Dropdown({ label, items }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={`nav-dropdown${open ? ' is-open' : ''}`} ref={wrapperRef}>
      <button
        type="button"
        className="nav-trigger"
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            window.requestAnimationFrame(() => {
              const first = wrapperRef.current?.querySelector('[role="menuitem"]');
              if (first instanceof HTMLElement) first.focus();
            });
          }
        }}
      >
        {label}
        <Icon name="chevron-down" />
      </button>
      <div className="nav-menu" role="menu" hidden={!open}>
        {items.map((item) => (
          <MenuItem key={item.label} item={item} onNavigate={() => setOpen(false)} />
        ))}
      </div>
    </div>
  );
}

export default function MarketingNav() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    function onScroll() { setScrolled(window.scrollY > 8); }
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKeyDown(event) {
      if (event.key === 'Escape') setMobileOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [mobileOpen]);

  return (
    <header className={`marketing-header${scrolled ? ' is-scrolled' : ''}`}>
      <div className="landing-container marketing-nav">
        <Brand href="/" />

        <nav className="marketing-links" aria-label="Primary navigation">
          <Dropdown label="Product" items={PRODUCT} />
          <Dropdown label="Developers" items={DEVELOPERS} />
          <Link href="/#pricing">Pricing</Link>
          <Link href="/docs">Docs</Link>
          <Link href="/blog">Blog</Link>
        </nav>

        <div className="marketing-actions">
          <Link className="marketing-signin" href="/login">Sign in</Link>
          <Link className="btn btn-primary btn-nav" href="/register">
            Start for free
            <Icon name="arrow_forward" />
          </Link>
          <button
            type="button"
            className="nav-mobile-toggle"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileOpen}
            aria-controls="marketing-mobile-nav"
            onClick={() => setMobileOpen((value) => !value)}
          >
            <Icon name={mobileOpen ? 'x-lg' : 'list'} />
          </button>
        </div>
      </div>

      {mobileOpen ? (
        <div className="mobile-nav" id="marketing-mobile-nav">
          <div className="landing-container mobile-nav-inner">
            <div className="mobile-nav-group">
              <p className="mobile-nav-label">Product</p>
              {PRODUCT.map((item) => (
                <Link key={item.label} href={item.href} onClick={() => setMobileOpen(false)}>
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </Link>
              ))}
            </div>
            <div className="mobile-nav-group">
              <p className="mobile-nav-label">Developers</p>
              {DEVELOPERS.map((item) => (item.external ? (
                <a key={item.label} href={item.href} target="_blank" rel="noreferrer" onClick={() => setMobileOpen(false)}>
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </a>
              ) : (
                <Link key={item.label} href={item.href} onClick={() => setMobileOpen(false)}>
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </Link>
              )))}
            </div>
            <div className="mobile-nav-group">
              <p className="mobile-nav-label">More</p>
              <Link href="/docs" onClick={() => setMobileOpen(false)}>
                <Icon name="menu-book" />
                <span>Docs</span>
              </Link>
              <Link href="/blog" onClick={() => setMobileOpen(false)}>
                <Icon name="list" />
                <span>Engineering notes</span>
              </Link>
              <Link href="/login" onClick={() => setMobileOpen(false)}>
                <Icon name="person" />
                <span>Sign in</span>
              </Link>
            </div>
            <Link href="/register" className="btn btn-primary btn-lg mobile-nav-cta" onClick={() => setMobileOpen(false)}>
              Start for free
              <Icon name="arrow_forward" />
            </Link>
          </div>
        </div>
      ) : null}
    </header>
  );
}
