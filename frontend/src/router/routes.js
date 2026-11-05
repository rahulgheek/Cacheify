/** Route table. Next.js owns routing; this table mirrors access rules. */

export const Routes = {
  login: '/login',
  register: '/register',
  verify: '/verify',
  databases: '/databases',
  databaseDetail: '/databases/:id',
  databaseSettings: '/databases/:id/settings',
  apiKeys: '/api-keys',
  profile: '/profile',
  admin: '/admin',
  privacy: '/privacy',
  manual: '/manual',
  docs: '/docs',
  docsPage: '/docs/:slug',
  blog: '/blog',
  blogPost: '/blog/:slug',
};

export const routeTable = [
  { pattern: Routes.login, page: 'login', access: 'public' },
  { pattern: Routes.register, page: 'register', access: 'public' },
  { pattern: Routes.verify, page: 'verify', access: 'user' },
  { pattern: Routes.privacy, page: 'privacy', access: 'public' },
  { pattern: Routes.manual, page: 'manual', access: 'public' },
  { pattern: Routes.docs, page: 'docs', access: 'public' },
  { pattern: Routes.docsPage, page: 'docsPage', access: 'public' },
  { pattern: Routes.blog, page: 'blog', access: 'public' },
  { pattern: Routes.blogPost, page: 'blogPost', access: 'public' },
  { pattern: Routes.databases, page: 'databases', access: 'user' },
  { pattern: Routes.databaseDetail, page: 'databaseDetail', access: 'user' },
  { pattern: Routes.databaseSettings, page: 'databaseSettings', access: 'user' },
  { pattern: Routes.apiKeys, page: 'apiKeys', access: 'user' },
  { pattern: Routes.profile, page: 'profile', access: 'user' },
  { pattern: Routes.admin, page: 'admin', access: 'admin' },
];

/**
 * Match a pathname to a route entry; params are extracted into an object.
 * Used by AuthGate for access decisions (Next.js does the actual routing).
 */
export function matchRoute(pathname) {
  for (const route of routeTable) {
    const routeParts = route.pattern.split('/').filter(Boolean);
    const pathParts = pathname.split('/').filter(Boolean);
    if (routeParts.length !== pathParts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < routeParts.length; i += 1) {
      if (routeParts[i].startsWith(':')) {
        params[routeParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (routeParts[i] !== pathParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}
