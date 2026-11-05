import Link from 'next/link';
import { Icon } from '../components/common/Icon.jsx';
import { NOTES } from '../content/notes.js';

const TOPICS = ['Architecture', 'Product', 'Security', 'Reliability'];

export default function BlogPage() {
  const [featured, ...rest] = NOTES;

  return (
    <div className="blog-page">
      <header className="blog-hero">
        <p className="blog-eyebrow">
          <span className="dot" aria-hidden="true" />
          Engineering notes
        </p>
        <h1>Notes from building a Redis platform over HTTP.</h1>
        <p className="blog-lead">
          Design decisions, constraints and the occasional trade-off we chose on
          purpose. No launch metrics, no benchmark theatre — just how the platform
          works and why.
        </p>
        <div className="blog-hero-meta">
          <span>
            <Icon name="list" />
            {`${NOTES.length} notes`}
          </span>
          <span>
            <Icon name="clock" />
            Updated October 2026
          </span>
          <span className="blog-topics" aria-label="Topics">
            {TOPICS.map((topic) => (
              <span className="blog-topic" key={topic}>{topic}</span>
            ))}
          </span>
        </div>
      </header>

      <article className="blog-featured">
        <div className="blog-featured-grid" aria-hidden="true" />
        <div className="blog-featured-main">
          <div className="blog-featured-kicker">
            <span className="blog-featured-tag">{featured.tag}</span>
            <span>{featured.displayDate}</span>
            <span aria-hidden="true">/</span>
            <span>{featured.readingTime}</span>
          </div>
          <h2>
            <Link href={`/blog/${featured.slug}`}>{featured.title}</Link>
          </h2>
          <p>{featured.summary}</p>
          <Link href={`/blog/${featured.slug}`} className="btn btn-light btn-sm blog-read">
            Read the note
            <Icon name="arrow_forward" />
          </Link>
        </div>
        <aside className="blog-featured-aside" aria-label="Inside this note">
          <p className="blog-aside-label">Inside this note</p>
          <ol>
            {featured.sections.map((section, index) => (
              <li key={section.heading}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                {section.heading}
              </li>
            ))}
          </ol>
          <p className="blog-aside-foot">
            <Icon name="info-circle" />
            {featured.takeaway}
          </p>
        </aside>
      </article>

      <div className="blog-list-head">
        <div>
          <p className="blog-eyebrow">
            <span className="dot" aria-hidden="true" />
            All notes
          </p>
          <h2>Read by topic</h2>
        </div>
        <p>
          Every note describes behavior that is implemented in this repository.
          Product limits are stated as defaults, not as universal guarantees.
        </p>
      </div>

      <div className="blog-grid">
        {rest.map((note) => (
          <article className="blog-card" key={note.slug}>
            <div className="blog-card-top">
              <span className="blog-topic">{note.tag}</span>
              <span className="blog-card-date">{note.displayDate}</span>
            </div>
            <h2>
              <Link href={`/blog/${note.slug}`}>{note.title}</Link>
            </h2>
            <p>{note.summary}</p>
            <div className="blog-card-foot">
              <span>
                <Icon name="clock" />
                {note.readingTime}
              </span>
              <Link href={`/blog/${note.slug}`} className="blog-card-link">
                Read note
                <Icon name="arrow_forward" />
              </Link>
            </div>
          </article>
        ))}
      </div>

      <section className="blog-cta">
        <div>
          <p className="blog-eyebrow">
            <span className="dot" aria-hidden="true" />
            Go deeper
          </p>
          <h2>The contract is in the docs.</h2>
          <p>
            Endpoints, TTL semantics, error codes and framework examples — including
            the Spring Boot bridge for teams keeping their RedisTemplate code.
          </p>
        </div>
        <div className="blog-cta-actions">
          <Link href="/docs" className="btn btn-primary">
            Read the developer manual
            <Icon name="arrow_forward" />
          </Link>
          <Link href="/register" className="btn btn-secondary">
            Create a free database
          </Link>
        </div>
      </section>
    </div>
  );
}
