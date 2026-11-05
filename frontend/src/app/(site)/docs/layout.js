/**
 * /docs section layout: sticky topic sidebar on the left, article column on
 * the right, common metadata template. Pages under this folder render inside
 * the (site) AuthGate, so the navbar/footer come along automatically.
 */

import DocsSidebar from '../../../components/docs/DocsSidebar.jsx';

export const metadata = {
  title: {
    template: '%s · Cacheify Docs',
    default: 'Documentation · Cacheify',
  },
  description:
    'Developer documentation for Cacheify: quick start, the RESP Redis gateway, the HTTP data plane, architecture, the mandatory TTL policy, error contracts and FAQ.',
};

export default function DocsLayout({ children }) {
  return (
    <div className="docs-shell">
      <DocsSidebar />
      <div className="docs-content docs-content-page">
        {children}
      </div>
    </div>
  );
}
