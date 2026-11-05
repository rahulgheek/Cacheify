import Link from 'next/link';
import { Icon } from '../components/common/Icon.jsx';
import CopyButton from '../components/features/landing/CopyButton.jsx';
import { getAdjacentNote } from '../content/notes.js';

function CodeBlock({ label, text }) {
  return (
    <div className="docs-code blog-code">
      <div className="docs-code-head">
        <span className="docs-code-label">{label}</span>
        <CopyButton
          text={text}
          label="Copy"
          copiedLabel="Copied"
          className="docs-copy"
          iconName="clipboard"
        />
      </div>
      <pre>{text}</pre>
    </div>
  );
}

export default function BlogPostPage({ note }) {
  const { previous, next } = getAdjacentNote(note.slug);

  return (
    <div className="blog-post">
      <Link href="/blog" className="blog-back">
        <Icon name="arrow-left" />
        All engineering notes
      </Link>

      <header className="blog-post-head">
        <div className="blog-post-kicker">
          <span className="blog-topic">{note.tag}</span>
          <span>{note.displayDate}</span>
          <span aria-hidden="true">/</span>
          <span>{note.readingTime}</span>
        </div>
        <h1>{note.title}</h1>
        <p className="blog-post-intro">{note.summary}</p>
      </header>

      <div className="blog-post-layout">
        <aside className="docs-toc blog-post-toc" aria-label="On this page">
          <p className="docs-toc-title">On this page</p>
          <nav>
            {note.sections.map((section, index) => (
              <a href={`#section-${index + 1}`} key={section.heading}>
                {section.heading}
              </a>
            ))}
            <a href="#takeaway">Takeaway</a>
          </nav>
        </aside>

        <article className="blog-post-body">
          <p className="blog-post-lede">{note.intro}</p>

          {note.sections.map((section, index) => (
            <section className="blog-post-section" id={`section-${index + 1}`} key={section.heading}>
              <h2>{section.heading}</h2>
              {(section.paragraphs || []).map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              {section.bullets ? (
                <ul>
                  {section.bullets.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}
              {section.code ? <CodeBlock label={section.code.label} text={section.code.text} /> : null}
            </section>
          ))}

          <aside className="blog-takeaway" id="takeaway">
            <span className="blog-takeaway-label">
              <Icon name="info-circle" />
              Takeaway
            </span>
            <p>{note.takeaway}</p>
          </aside>

          <nav className="blog-post-nav" aria-label="More engineering notes">
            {previous ? (
              <Link href={`/blog/${previous.slug}`} className="blog-post-nav-link">
                <span>Previous note</span>
                <strong>{previous.title}</strong>
              </Link>
            ) : <span />}
            {next ? (
              <Link href={`/blog/${next.slug}`} className="blog-post-nav-link is-next">
                <span>Next note</span>
                <strong>{next.title}</strong>
              </Link>
            ) : null}
          </nav>

          <div className="blog-post-cta">
            <div>
              <h2>Try the contract yourself.</h2>
              <p>Five databases are free. Create one, mint a scoped key and send a command.</p>
            </div>
            <div className="blog-cta-actions">
              <Link href="/register" className="btn btn-primary">
                Start for free
                <Icon name="arrow_forward" />
              </Link>
              <Link href="/docs" className="btn btn-secondary">Read the docs</Link>
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}
