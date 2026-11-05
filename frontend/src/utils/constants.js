/** Route paths and constants (mirrors the platform contract). */

export const ROUTES = {
  login: '/login',
  register: '/register',
  verify: '/verify',
  databases: '/databases',
  apiKeys: '/api-keys',
  admin: '/admin',
  profile: '/profile',
  privacy: '/privacy',
  docs: '/docs',
  manual: '/manual',
};

export const SESSION_KEY = 'rhp.session';

export const KEY_TYPES = ['string', 'list', 'set', 'hash', 'zset'];

export const DATABASE_STATUS = {
  active: 'Active',
  archived: 'Archived',
};

export const USER_STATUS = {
  active: 'Active',
  suspended: 'Suspended',
};
