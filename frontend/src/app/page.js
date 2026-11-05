import Link from 'next/link';
import '../styles/landing.css';
import MarketingNav from '../components/features/landing/MarketingNav.jsx';
import HowItWorks from '../components/features/landing/HowItWorks.jsx';
import ServerStack from '../components/features/landing/ServerStack.jsx';
import InfraVisual from '../components/features/landing/InfraVisual.jsx';
import DashboardPreview from '../components/features/landing/DashboardPreview.jsx';
import CopyButton from '../components/features/landing/CopyButton.jsx';
import Footer from '../components/layout/Footer.jsx';
import { Icon } from '../components/common/Icon.jsx';
import { redisConnectionString } from '../utils/config.js';

export const metadata = {
  title: 'Cacheify — Redis-compatible databases over one connection string',
  description:
    'Isolated Redis-compatible databases with scoped API keys, quotas and mandatory TTL expiry. Five databases free, no card required.',
};

const INTEGRATIONS = [
  { mark: 'JS', label: 'Node.js' },
  { mark: 'PY', label: 'Python' },
  { mark: 'GO', label: 'Go' },
  { mark: '{}', label: 'cURL' },
  { mark: 'DK', label: 'Docker' },
  { mark: 'CI', label: 'CI / Cron' },
  { mark: 'AI', label: 'AI agents' },
];

const FEATURES = [
  {
    icon: 'database',
    title: 'Isolated databases',
    description:
      'Every database is a sealed namespace. Cross-tenant reads return 404, so the platform never confirms that another account’s database exists.',
    meta: 'Tenant isolation',
  },
  {
    icon: 'key',
    title: 'Scoped API keys',
    description:
      'Exactly one active key per database, read-only or read-write. A write from a read-only key is refused before the command executes.',
    meta: 'One key per database',
  },
  {
    icon: 'http',
    title: 'HTTP data plane',
    description:
      'Work with strings, lists, sets, hashes and sorted sets over JSON. No TCP client, Redis driver or special runtime required.',
    meta: '60+ Redis-compatible commands',
  },
  {
    icon: 'clock',
    title: 'Expiry on every key',
    description:
      'Every key carries a TTL — 24 hours by default, configurable per write. PERSIST is rejected, so forgotten keys cannot quietly accumulate.',
    meta: 'Mandatory TTL',
  },
  {
    icon: 'hdd-network',
    title: 'Bring your own Redis',
    description:
      'Operators can point the data plane at a real Redis server. Each platform database becomes an isolated, namespaced tenant on that server.',
    meta: 'Optional remote backend',
  },
  {
    icon: 'sliders',
    title: 'Quotas that hold',
    description:
      'Database, key and value limits are enforced with atomic rollback. Admins can search accounts, adjust quotas and suspend access.',
    meta: 'Free-plan defaults',
  },
];

const STATS = [
  { value: '5', label: 'Databases per account', note: 'Free-plan allowance' },
  { value: '10,000', label: 'Keys per database', note: 'Default quota' },
  { value: '512 KiB', label: 'Maximum value size', note: 'Default quota' },
  { value: '24h', label: 'Default TTL', note: 'Every key expires' },
  { value: '60+', label: 'Redis commands', note: 'Across five data types' },
  { value: '$0', label: 'Plan price', note: 'No card required' },
];

const COMPARISON = [
  {
    capability: 'Start cost',
    cacheify: '$0',
    selfHosted: 'Server, time and maintenance',
    managed: 'Provider billing',
  },
  {
    capability: 'Connection',
    cacheify: 'One redis:// string',
    selfHosted: 'Redis TCP client',
    managed: 'Redis TCP client',
  },
  {
    capability: 'Credentials',
    cacheify: 'Per database · read-only or read-write',
    selfHosted: 'ACLs you configure',
    managed: 'Provider IAM and network rules',
  },
  {
    capability: 'Expiry',
    cacheify: 'Enforced on every key',
    selfHosted: 'Policy you operate',
    managed: 'Optional or provider setting',
  },
  {
    capability: 'Where data lives',
    cacheify: 'Embedded engine or your Redis server',
    selfHosted: 'Your VM',
    managed: 'Provider account and region',
  },
  {
    capability: 'Time to first key',
    cacheify: 'Create a database, issue a key, send a request',
    selfHosted: 'Provision, harden and deploy',
    managed: 'Account, billing and network setup',
  },
];

const STEPS = [
  {
    number: '01',
    title: 'Create a free account',
    description:
      'Sign up with an email and password, verify the code, then create a database. Five are included from the first minute.',
    endpoint: 'Dashboard: Databases → New database',
    href: '/register',
    linkLabel: 'Create an account',
    icon: 'person',
  },
  {
    number: '02',
    title: 'Mint the scoped key',
    description:
      'Open the database and create its single active key. Choose read-only or read-write; the plaintext token is shown once.',
    endpoint: 'Dashboard: database page → Create key',
    href: '/docs/quickstart',
    linkLabel: 'Read the quick start',
    icon: 'key',
  },
  {
    number: '03',
    title: 'Connect with one line',
    description:
      'Any native Redis client dials the redis:// string with your key as the password. Add an expiry when a key needs to live longer than a day.',
    endpoint: 'redis-cli -u "$REDIS_URL" PING',
    href: '/docs/redis-gateway',
    linkLabel: 'See the gateway guide',
    icon: 'cable',
  },
];

const PRICING_INCLUDES = [
  '5 isolated databases',
  '10,000 keys per database',
  '512 KiB maximum value',
  'Scoped read-only or read-write keys',
  'Native Redis protocol with command console',
  'Mandatory TTL with per-write expiry',
  'Quotas and admin controls',
  'No credit card, no trial clock',
];

export default function LandingPage() {
  const quickCommand = `redis-cli -u "${redisConnectionString('<your-key>')}" PING   # -> PONG`;

  return (
    <div className="landing">
      <a className="skip-link" href="#main">Skip to content</a>
      <MarketingNav />

      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="landing-container hero-grid">
            <div className="hero-copy">
              <p className="landing-eyebrow">
                <span className="dot" />
                Serverless Redis · Free for every account
              </p>

              <h1 id="hero-title">
                Your Redis cache,
                <br />
                <span className="hero-accent">without the server.</span>
              </h1>

              <p className="hero-lead">
                Cacheify gives you isolated Redis-compatible databases behind one
                connection string. Scoped keys, quotas and mandatory expiry are
                enforced before a command ever runs. Five databases are free.
              </p>

              <div className="hero-actions">
                <Link href="/register" className="btn btn-primary btn-lg">
                  <Icon name="bolt" />
                  Start for free
                </Link>
                <a href="#how-it-works" className="btn btn-secondary btn-lg">
                  <Icon name="play-circle" />
                  See how it works
                </a>
              </div>

              <ul className="hero-trust">
                <li><Icon name="check2-circle" />5 databases, free</li>
                <li><Icon name="credit_card_off" />No credit card</li>
                <li><Icon name="clock" />Every key expires</li>
              </ul>
            </div>

            <ServerStack />
          </div>
        </section>

        <section className="integration-strip" aria-label="Works with your stack">
          <div className="landing-container integration-inner">
            <p className="integration-label">Works with the stack you already run</p>
            <ul className="integration-list">
              {INTEGRATIONS.map((integration) => (
                <li key={integration.label}>
                  <span className="integration-mark" aria-hidden="true">{integration.mark}</span>
                  {integration.label}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="landing-section howit-section" id="how-it-works" aria-labelledby="howit-title">
          <div className="landing-container">
            <HowItWorks />
          </div>
        </section>

        <section className="landing-section product-section" aria-labelledby="product-title">
          <div className="landing-container product-grid">
            <DashboardPreview />

            <div className="product-copy">
              <p className="landing-eyebrow">
                <span className="dot" />
                The console
              </p>
              <h2 id="product-title">The whole lifecycle, in one place.</h2>
              <p>
                Create a database, issue its scoped key, browse keys with their
                remaining TTL and run commands against the same API your application
                uses. No CLI to install.
              </p>

              <ul className="check-list">
                <li>
                  <Icon name="grid-1x2" />
                  <span>
                    <strong>Database overview</strong>
                    Usage, status and connection details at a glance.
                  </span>
                </li>
                <li>
                  <Icon name="key" />
                  <span>
                    <strong>Key browser and editor</strong>
                    Typed values, search and explicit expiry controls.
                  </span>
                </li>
                <li>
                  <Icon name="terminal" />
                  <span>
                    <strong>Command console</strong>
                    Redis-style commands against your own database, through the API.
                  </span>
                </li>
              </ul>

              <Link href="/register" className="text-link">
                Create a free database
                <Icon name="arrow_forward" />
              </Link>
            </div>
          </div>
        </section>

        <section className="landing-section features-section" id="features" aria-labelledby="features-title">
          <div className="landing-container">
            <div className="section-head">
              <div>
                <p className="landing-eyebrow">
                  <span className="dot" />
                  Product
                </p>
                <h2 id="features-title">Safety rails, without the operations.</h2>
              </div>
              <p className="section-lede">
                Everything that normally needs a platform team — isolation, scoped
                credentials, quotas and expiry — is part of the request path.
              </p>
            </div>

            <div className="feature-grid">
              {FEATURES.map((feature) => (
                <article className="feature-card" key={feature.title}>
                  <span className="feature-icon">
                    <Icon name={feature.icon} />
                  </span>
                  <h3>{feature.title}</h3>
                  <p>{feature.description}</p>
                  <p className="feature-meta">{feature.meta}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-section infrastructure-section" id="infrastructure" aria-labelledby="infrastructure-title">
          <div className="landing-container">
            <div className="section-head">
              <div>
                <p className="landing-eyebrow">
                  <span className="dot" />
                  Architecture
                </p>
                <h2 id="infrastructure-title">One request path. Two ways to store data.</h2>
              </div>
              <p className="section-lede">
                Permissions and quotas are checked on every request, before the
                command reaches an isolated database namespace.
              </p>
            </div>

            <InfraVisual />
          </div>
        </section>

        <section className="stats-section" aria-labelledby="stats-title">
          <div className="landing-container">
            <div className="stats-head">
              <h2 id="stats-title">The free plan, in numbers.</h2>
              <p>Defaults verified in the product — not marketing estimates.</p>
            </div>
            <dl className="stats-grid">
              {STATS.map((stat) => (
                <div className="stat-item" key={stat.label}>
                  <dt>{stat.label}</dt>
                  <dd>{stat.value}</dd>
                  <span>{stat.note}</span>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="landing-section comparison-section" aria-labelledby="comparison-title">
          <div className="landing-container">
            <div className="section-head">
              <div>
                <p className="landing-eyebrow">
                  <span className="dot" />
                  Trade-offs
                </p>
                <h2 id="comparison-title">A different shape of Redis hosting.</h2>
              </div>
              <p className="section-lede">
                Cacheify optimizes for a browser console, the native Redis
                protocol and strong defaults. Those choices are not free — here
                is the honest comparison.
              </p>
            </div>

            <div className="comparison-card">
              <div className="table-scroll">
                <table className="comparison-table">
                  <caption className="sr-only">
                    Comparison of Cacheify with self-managed Redis and a typical managed Redis service.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Capability</th>
                      <th scope="col" className="is-cacheify">Cacheify</th>
                      <th scope="col">Self-managed Redis</th>
                      <th scope="col">Typical managed Redis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMPARISON.map((row) => (
                      <tr key={row.capability}>
                        <th scope="row">{row.capability}</th>
                        <td className="is-cacheify">{row.cacheify}</td>
                        <td>{row.selfHosted}</td>
                        <td>{row.managed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="comparison-note">
                A general comparison of deployment categories, not a specific vendor.
                Managed Redis offerings vary by provider.
              </p>
            </div>
          </div>
        </section>

        <section className="landing-section quickstart-section" id="quickstart" aria-labelledby="quickstart-title">
          <div className="landing-container">
            <div className="section-head section-head-centered">
              <p className="landing-eyebrow">
                <span className="dot" />
                Quick start
              </p>
              <h2 id="quickstart-title">Three steps to your first key.</h2>
              <p className="section-lede">
                No region picker, no network wiring. The dashboard sets everything
                up, and your application connects like any other Redis client.
              </p>
            </div>

            <ol className="steps-grid">
              {STEPS.map((step) => (
                <li className="step-card" key={step.number}>
                  <div className="step-head">
                    <span className="step-number">{step.number}</span>
                    <span className="step-icon">
                      <Icon name={step.icon} />
                    </span>
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                  <code className="step-endpoint">{step.endpoint}</code>
                  <Link href={step.href} className="text-link">
                    {step.linkLabel}
                    <Icon name="arrow_forward" />
                  </Link>
                </li>
              ))}
            </ol>

            <div className="quick-command">
              <div className="quick-command-copy">
                <span className="quick-command-label">First request</span>
                <code>{quickCommand}</code>
              </div>
              <CopyButton
                text={quickCommand}
                label="Copy command"
                copiedLabel="Copied"
                className="btn btn-secondary btn-sm quick-command-copy"
              />
            </div>
          </div>
        </section>

        <section className="landing-section pricing-section" id="pricing" aria-labelledby="pricing-title">
          <div className="landing-container">
            <div className="section-head">
              <div>
                <p className="landing-eyebrow">
                  <span className="dot" />
                  Pricing
                </p>
                <h2 id="pricing-title">Free, and that is the whole price list.</h2>
              </div>
              <p className="section-lede">
                One plan with the full platform included. No card, no trial clock and
                no gateway to the data plane.
              </p>
            </div>

            <div className="pricing-grid">
              <div className="pricing-card">
                <div className="pricing-card-head">
                  <span className="pricing-plan">Free plan</span>
                  <span className="badge badge-status-active">Available now</span>
                </div>
                <p className="pricing-price">
                  <span aria-hidden="true">$</span>0
                  <small>forever</small>
                </p>
                <p className="pricing-copy">
                  For prototypes, side projects and production services that want
                  strong defaults without another bill.
                </p>
                <ul className="pricing-list">
                  {PRICING_INCLUDES.map((item) => (
                    <li key={item}>
                      <Icon name="check-lg" />
                      {item}
                    </li>
                  ))}
                </ul>
                <Link href="/register" className="btn btn-primary btn-lg pricing-cta">
                  Create your free database
                  <Icon name="arrow_forward" />
                </Link>
                <p className="pricing-foot">
                  Already have an account? <Link href="/login">Sign in</Link>
                </p>
              </div>

              <aside className="pricing-aside" aria-label="Plan notes">
                <div className="pricing-aside-block">
                  <span className="pricing-aside-icon">
                    <Icon name="shield-lock" />
                  </span>
                  <div className="pricing-aside-copy">
                    <h3>No paid tier. No surprises.</h3>
                    <p>
                      There is no upgrade button, no usage invoice and no feature held
                      behind a paywall. The free plan is the plan.
                    </p>
                  </div>
                </div>
                <div className="pricing-aside-block">
                  <span className="pricing-aside-icon">
                    <Icon name="hdd-network" />
                  </span>
                  <div className="pricing-aside-copy">
                    <h3>Operators can connect real Redis.</h3>
                    <p>
                      A deployment can run on the embedded data plane or point at a
                      Redis server through environment configuration. The client
                      contract stays the same.
                    </p>
                  </div>
                </div>
                <div className="pricing-aside-block">
                  <span className="pricing-aside-icon">
                    <Icon name="clock" />
                  </span>
                  <div className="pricing-aside-copy">
                    <h3>Expiry is not optional.</h3>
                    <p>
                      Every write needs an expiry or inherits the 24-hour default. That
                      is a deliberate limit, and it keeps forgotten keys from becoming
                      silent storage costs.
                    </p>
                  </div>
                </div>
                <a className="text-link" href="#quickstart">
                  See the quick start
                  <Icon name="arrow_forward" />
                </a>
              </aside>
            </div>
          </div>
        </section>

        <section className="landing-section final-cta-section">
          <div className="landing-container">
            <div className="final-cta">
              <div className="final-cta-grid" aria-hidden="true" />
              <p className="landing-eyebrow landing-eyebrow-light">
                <span className="dot" />
                Free for every account
              </p>
              <h2>Your first key is one request away.</h2>
              <p>
                Create a database, issue a scoped key and send a command. No card and
                no server to run.
              </p>
              <div className="final-cta-actions">
                <Link href="/register" className="btn btn-primary btn-lg">
                  Start for free
                  <Icon name="arrow_forward" />
                </Link>
                <Link href="/docs" className="btn btn-dark-outline btn-lg">
                  Read the documentation
                </Link>
              </div>
              <p className="final-cta-meta">
                5 databases · 10,000 keys each · every key expires
              </p>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
