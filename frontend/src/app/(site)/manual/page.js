import { redirect } from 'next/navigation';

/**
 * The manual was split into the multi-page /docs section (November 2026).
 * Old /manual links (bookmarks, docs, footer history) keep working by
 * redirecting to the docs hub.
 */
export default function ManualRedirectPage() {
  redirect('/docs');
}
