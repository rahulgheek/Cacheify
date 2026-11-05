/**
 * "How it works" — the marketing replacement for the demo console. Not an
 * interactive widget: an honest, CSS-only animation of one request traveling
 * the real path (app → API entry → permission/quota checks → tenant
 * namespace → data store) and the reply coming back. Prefers-reduced-motion
 * renders the same story statically.
 */

import { Icon } from '../../common/Icon.jsx';

const NODES = [
  {
    icon: 'terminal',
    kicker: 'Your code',
    label: 'SET greeting hello',
    caption: 'Any HTTP client or Redis driver',
  },
  {
    icon: 'hdd-network',
    kicker: 'Entry',
    label: 'Gateway / HTTPS API',
    caption: 'RESP wire or JSON request',
  },
  {
    icon: 'shield-lock',
    kicker: 'Checks',
    label: 'Key · permission · quota',
    caption: 'Bearer rk_ verified; read-only writes refused before execution',
  },
  {
    icon: 'diagram-3',
    kicker: 'Namespace',
    label: 'rh:<tenant>:',
    caption: 'Your database is a sealed namespace',
  },
  {
    icon: 'clock',
    kicker: 'Store',
    label: 'Stored · 24h TTL',
    caption: 'Every key expires — even the ones you forgot',
  },
];

export default function HowItWorks() {
  return (
    <div className="howit">
      <div className="section-head">
        <div>
          <p className="landing-eyebrow">
            <span className="dot" />
            How it works
          </p>
          <h2 id="howit-title">Watch one request do the work.</h2>
        </div>
        <p className="section-lede">
          A continuous loop of the real path: the key is verified, the namespace
          is stamped, the TTL is armed, and the reply comes back through the
          same route.
        </p>
      </div>

      <div
        className="howit-stage"
        role="img"
        aria-label="Animated request path: your code sends SET greeting hello; it passes key, permission and quota checks; the tenant namespace is stamped; the key is stored with a 24 hour TTL; and the OK reply travels back."
      >
        <div className="howit-track">
          {NODES.map((node) => (
            <div className="howit-node" key={node.kicker}>
              <span className="howit-node-icon"><Icon name={node.icon} /></span>
              <span className="howit-node-kicker">{node.kicker}</span>
              <code className="howit-node-code">{node.label}</code>
              <small>{node.caption}</small>
            </div>
          ))}
          <span className="howit-packet howit-packet-request" aria-hidden="true" />
          <span className="howit-packet howit-packet-reply" aria-hidden="true" />
        </div>
      </div>

      <ol className="howit-steps">
        <li>
          <span className="howit-step-dot" aria-hidden="true" />
          <strong>Authenticate</strong>
          <p>The key — the password slot of your connection string — is resolved on the first command.</p>
        </li>
        <li>
          <span className="howit-step-dot" aria-hidden="true" />
          <strong>Check permission + quota</strong>
          <p>Read-only writes and over-quota work are refused here, before anything runs.</p>
        </li>
        <li>
          <span className="howit-step-dot" aria-hidden="true" />
          <strong>Stamp the namespace</strong>
          <p>Keys land inside an isolated namespace; cross-tenant reads return 404.</p>
        </li>
        <li>
          <span className="howit-step-dot" aria-hidden="true" />
          <strong>Store with a TTL</strong>
          <p>Writes without EX get the 24-hour default. PERSIST is rejected by design.</p>
        </li>
      </ol>

      <div className="howit-actions">
        <a className="text-link" href="/docs">
          Read the documentation
          <Icon name="arrow_forward" />
        </a>
      </div>
    </div>
  );
}
