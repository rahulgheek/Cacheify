/**
 * Shared building blocks for the documentation pages: code blocks with copy,
 * endpoint/error tables, callouts and the single-line connection string.
 * Presentation is intentionally plain typography on the docs tokens.
 */

import CopyButton from '../features/landing/CopyButton.jsx';
import { Icon } from '../common/Icon.jsx';
import { redisConnectionString } from '../../utils/config.js';

export function CodeBlock({ label, text, oneLine = false }) {
  return (
    <div className={`docs-code${oneLine ? ' docs-code-oneline' : ''}`}>
      <div className="docs-code-head">
        {label ? <span className="docs-code-label">{label}</span> : <span />}
        <CopyButton
          text={text}
          label="Copy code"
          copiedLabel="Copied"
          className="docs-copy"
          iconName="clipboard"
        />
      </div>
      <pre>{text}</pre>
    </div>
  );
}

export function DocTable({ headers, rows }) {
  return (
    <table className="docs-table">
      <thead>
        <tr>
          {headers.map((header) => (
            <th key={header} scope="col">{header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Card grid linking onward from the docs overview to the topic pages. */
export function DocGrid({ children }) {
  return <div className="docs-grid">{children}</div>;
}

export function DocCard({ href, icon, title, children }) {
  return (
    <a className="docs-card" href={href}>
      <span className="docs-card-icon"><Icon name={icon} /></span>
      <strong>{title}</strong>
      <small>{children}</small>
      <Icon name="arrow-right" className="docs-card-arrow" />
    </a>
  );
}

/** Emphasized note that states a platform rule, not decoration. */
export function Callout({ kind = 'info', title, children }) {
  return (
    <aside className={`docs-callout is-${kind}`}>
      <Icon name={kind === 'warn' ? 'exclamation-triangle' : 'info-circle'} />
      <div>
        {title ? <strong>{title}</strong> : null}
        <p>{children}</p>
      </div>
    </aside>
  );
}

/**
 * The connection string — one line, one credential: native Redis clients dial
 * this, with the database's active API key as the password slot. `keyHint` is
 * deliberately masked — real keys are shown once, in the dashboard, at mint
 * time.
 */
export function ConnectionString() {
  return (
    <CodeBlock
      oneLine
      label="Connection string — any native Redis client"
      text={redisConnectionString('<your-key>')}
    />
  );
}
