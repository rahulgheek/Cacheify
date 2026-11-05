import Link from 'next/link';
import Navbar from '../components/layout/Navbar.jsx';
import Footer from '../components/layout/Footer.jsx';
import { Icon } from '../components/common/Icon.jsx';

export default function NotFound() {
  return (
    <div className="app-shell">
      <Navbar />
      <main id="app-main" className="app-main" tabIndex={-1} style={{ maxWidth: '720px' }}>
        <div className="card" style={{ marginTop: '48px', textAlign: 'center', padding: 'clamp(32px, 6vw, 64px)' }}>
          <p className="card-kicker" style={{ marginBottom: '14px' }}>Error 404</p>
          <h1 style={{ margin: '0 0 10px', fontSize: 'clamp(30px, 5vw, 44px)', fontWeight: 680, letterSpacing: '-0.04em' }}>
            This page does not exist.
          </h1>
          <p className="muted" style={{ maxWidth: '48ch', margin: '0 auto 24px', fontSize: '14.5px' }}>
            The address may have changed or the page was removed. Head back to the
            console, or read the documentation to find what you need.
          </p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href="/databases" className="btn btn-primary">
              <Icon name="grid-1x2" />
              Back to overview
            </Link>
            <Link href="/docs" className="btn btn-secondary">
              <Icon name="menu-book" />
              Documentation
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
