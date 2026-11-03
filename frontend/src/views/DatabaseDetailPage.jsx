'use client';

/**
 * Database detail page (screen archetype: Focus + Do).
 * Top: database identity + both connection strings (HTTP data plane and the
 * redis:// RESP gateway for native clients) + the database's single API key
 * (exactly one active key per database, managed in place).
 * Below: the key browser split view and the command console.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/common/Icon.jsx';
import { Button, Spinner, Badge } from '../components/common/atoms.jsx';
import Field from '../components/common/Field.jsx';
import Modal from '../components/common/Modal.jsx';
import Breadcrumbs from '../components/layout/Breadcrumbs.jsx';
import KeyList from '../components/features/keys/KeyList.jsx';
import KeyEditor from '../components/features/keys/KeyEditor.jsx';
import Console from '../components/features/keys/Console.jsx';
import PlaintextReveal, { copyToClipboard } from '../components/features/keys/PlaintextReveal.jsx';
import { getDatabase, deleteDatabase } from '../services/databaseService.js';
import { getKey } from '../services/databaseService.js';
import {
  getDatabaseApiKey, createDatabaseApiKey, revokeApiKey,
} from '../services/adminService.js';
import { errorToMessage, validateRequired } from '../utils/validators.js';
import { formatBytes, formatDate } from '../utils/format.js';
import { showToast, showErrorToast } from '../components/common/toasts.js';
import { navigate } from '../router/navigate.js';
import { apiOrigin, redisConnectionString } from '../utils/config.js';

const PERMISSIONS = [
  { value: 'read-write', label: 'Read and write', hint: 'Full data access: get, set, delete, TTL.' },
  { value: 'read-only', label: 'Read only', hint: 'Can read values and keys. Writes are denied server-side.' },
];

/** Label + mono value + copy chip, stacked. */
function connectionRow(label, value, monoLarge) {
  return (
    <div className="connection-row">
      <div className="connection-row-label">{label}</div>
      <div className="connection-row-value">
        <div className={`mono${monoLarge ? ' is-large' : ''}`}>{value}</div>
        <Button
          label="Copy"
          iconName="clipboard"
          variant="ghost"
          ariaLabel={`Copy ${label.toLowerCase()}`}
          onClick={() => copyToClipboard(value, 'Copied to clipboard', 'Copy failed. Select the value and copy manually.')}
        />
      </div>
    </div>
  );
}

export default function DatabaseDetailPage({ dbId }) {
  const [database, setDatabase] = useState(null);
  const [loadError, setLoadError] = useState(null);

  /* Key column state: 'loading' | 'error' | 'none' | 'ready' */
  const [keyPhase, setKeyPhase] = useState('loading');
  const [keyError, setKeyError] = useState(null);
  const [activeKey, setActiveKey] = useState(null);

  /* Split view selection */
  const [selectedKey, setSelectedKey] = useState(null);
  const [editorMode, setEditorMode] = useState(null); // null | 'ready' | 'cleared'
  const [editorDetail, setEditorDetail] = useState(null);
  const [editorSeq, setEditorSeq] = useState(0);

  /* Create key modal */
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [permission, setPermission] = useState('read-write');
  const [createKeyError, setCreateKeyError] = useState(null);
  const [createKeyBusy, setCreateKeyBusy] = useState(false);
  const keyNameFieldRef = useRef(null);

  /* Plaintext-once reveal */
  const [reveal, setReveal] = useState({ open: false, plaintext: '' });

  /* Confirmations */
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDatabase(dbId)
      .then(({ data }) => {
        if (!cancelled) setDatabase(data.database);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorToMessage(err, 'Could not load this database'));
      });
    return () => {
      cancelled = true;
    };
  }, [dbId]);

  async function refreshKeySection() {
    setKeyPhase('loading');
    try {
      const { data } = await getDatabaseApiKey(dbId);
      const apiKey = data.apiKey;
      setActiveKey(apiKey);
      setKeyPhase(apiKey ? 'ready' : 'none');
    } catch (err) {
      setKeyError(errorToMessage(err, 'Could not load the key state'));
      setKeyPhase('error');
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await getDatabaseApiKey(dbId);
        if (cancelled) return;
        setActiveKey(data.apiKey);
        setKeyPhase(data.apiKey ? 'ready' : 'none');
      } catch (err) {
        if (cancelled) return;
        setKeyError(errorToMessage(err, 'Could not load the key state'));
        setKeyPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dbId]);

  /* --------------------------- Key selection ------------------------------- */

  async function handleSelect(keyRow) {
    setSelectedKey(keyRow.name);
    try {
      const { data } = await getKey(dbId, keyRow.name);
      setEditorDetail({ name: keyRow.name, ...data.key });
      setEditorMode('editor');
      setEditorSeq((seq) => seq + 1);
    } catch (err) {
      showErrorToast(errorToMessage(err, 'Could not load key'));
    }
  }

  /* ----------------------------- Create key -------------------------------- */

  function openCreateKey() {
    setKeyName('');
    setPermission('read-write');
    setCreateKeyError(null);
    setCreateKeyBusy(false);
    setCreateKeyOpen(true);
  }

  async function submitCreateKey() {
    if (!keyNameFieldRef.current.validate()) return;
    setCreateKeyBusy(true);
    try {
      const { data } = await createDatabaseApiKey(dbId, {
        name: keyName.trim(),
        permission,
      });
      setCreateKeyOpen(false);
      void refreshKeySection();
      setReveal({ open: true, plaintext: data.plaintext });
    } catch (err) {
      setCreateKeyError(errorToMessage(err, 'Could not create the key'));
      setCreateKeyBusy(false);
    }
  }

  /* ------------------------------ Revoke key -------------------------------- */

  async function submitRevoke() {
    try {
      await revokeApiKey(activeKey.id);
      showToast(`Key "${activeKey.name}" revoked`);
      void refreshKeySection();
    } catch (err) {
      showErrorToast(errorToMessage(err, 'Could not revoke the key'));
    }
  }

  /* --------------------------- Delete database ------------------------------ */

  async function confirmDeleteDatabase() {
    try {
      await deleteDatabase(dbId);
      showToast('Database deleted');
      navigate('/databases');
    } catch (err) {
      showErrorToast(errorToMessage(err, 'Could not delete database'));
    }
  }

  /* -------------------------------- Loader ---------------------------------- */

  if (loadError) {
    return (
      <div>
        <p className="inline-error" role="alert">{loadError}</p>
        <Button label="Back to overview" iconName="arrow-left" onClick={() => navigate('/databases')} />
      </div>
    );
  }

  if (!database) {
    return <Spinner label="Loading database" />;
  }

  /* --------------------------- Key column body ------------------------------ */

  function keyColumn() {
    if (keyPhase === 'loading') {
      return <Spinner label="Loading key state" />;
    }
    if (keyPhase === 'error') {
      return <p className="inline-error" role="alert">{keyError}</p>;
    }

    return (
      <>
        <div className="key-panel-head">
          <div className="key-panel-title">API key</div>
          <Badge
            text={activeKey ? '1 key active' : 'no key yet'}
            kind={activeKey ? 'status-active' : 'status-archived'}
          />
        </div>

        {!activeKey ? (
          <>
            <p className="key-panel-empty">
              No API key yet. This database allows exactly one active key - mint it
              here and use its plaintext as the bearer token above.
            </p>
            <Button label="Create API key" iconName="key" variant="primary" onClick={openCreateKey} />
          </>
        ) : (
          <>
            <dl className="key-meta-grid">
              <dt>Name</dt>
              <dd>{activeKey.name}</dd>
              <dt>Token prefix</dt>
              <dd className="mono">{`${activeKey.prefix}\u2026`}</dd>
              <dt>Created</dt>
              <dd>{formatDate(activeKey.createdAt)}</dd>
              <dt>Last used</dt>
              <dd>{activeKey.lastUsedAt ? formatDate(activeKey.lastUsedAt) : 'Never'}</dd>
              <dt>Permission</dt>
              <dd>
                <Badge
                  text={activeKey.permission === 'read-only' ? 'Read only' : 'Read + write'}
                  kind={activeKey.permission === 'read-only' ? 'perm-read-only' : 'perm-read-write'}
                  iconName={activeKey.permission === 'read-only' ? 'eye' : 'pencil'}
                />
              </dd>
            </dl>
            <p className="hint">One active key per database. To rotate: revoke first, then mint a replacement.</p>
            <Button
              label="Revoke key"
              iconName="slash-circle"
              variant="danger"
              ariaLabel={`Revoke ${activeKey.name}`}
              onClick={() => setRevokeConfirm(true)}
            />
          </>
        )}
      </>
    );
  }

  /* ------------------------------ Full view --------------------------------- */

  const statChips = [
    ['Keys', database.stats ? database.stats.totalKeys : '-'],
    ['Size', database.stats ? formatBytes(database.stats.totalBytes) : '-'],
    ['Created', formatDate(database.createdAt)],
  ];

  return (
    <div>
      <Breadcrumbs
        trail={[
          { label: 'Databases', href: '/databases' },
          { label: database.name, current: true },
        ]}
      />

      {/* ------------------------------ Heading ------------------------------ */}
      <div className="db-detail-head">
        <div className="db-detail-heading">
          <h1 className="db-detail-title">
            <Icon name={database.status === 'active' ? 'database' : 'lock'} />
            <span className="db-detail-name">{database.name}</span>
            <Badge text={database.status} kind={`status-${database.status}`} />
          </h1>
          {database.description ? <p className="db-detail-desc">{database.description}</p> : null}
        </div>
        <div className="db-detail-stats">
          {statChips.map(([label, value]) => (
            <span className="db-detail-stat" key={label}>
              <span>{label}</span>
              <span>{value}</span>
            </span>
          ))}
        </div>
      </div>

      {/* --------------------------- Connect card ---------------------------- */}
      <div className="card db-connect-card">
        <div className="card-title">
          <Icon name="cable" />
          {' Connect your app'}
        </div>
        <div className="db-connect-grid">
          <div className="db-connect-main">
            {connectionRow('Database ID', database.id, false)}
            {connectionRow('Connection string', `${apiOrigin()}/api/data/${dbId}`, true)}
            {connectionRow('Auth header', 'Authorization: Bearer <your API key>', false)}
            {connectionRow('Redis protocol', redisConnectionString('<your API key>'), true)}
            <p className="hint">
              Every data call goes under the connection string (strings/, keys/, expire, command). Keep the key on your server - it is full access to this database within its permission.
            </p>
            <p className="hint">
              Native Redis clients (redis-cli, ioredis, redis-py, Jedis) use the Redis row instead: the password slot is your active API key - the same rk_ value from the Auth header - and the database is always db 0.
            </p>
          </div>
          <div className="db-connect-side">
            {keyColumn()}
          </div>
        </div>
      </div>

      {/* -------------------- Archived notice + split view ------------------- */}
      {database.status === 'archived' ? (
        <p className="inline-error" role="status">
          This database is archived and read-only. Restore it from Dashboard settings to make changes.
        </p>
      ) : null}

      <div className="split-view">
        <div className="card">
          <div className="card-title">Keys</div>
          <KeyList dbId={dbId} selected={selectedKey} onSelect={handleSelect} />
        </div>
        <div className="card">
          <div className="card-title">Key details</div>
          <KeyEditor
            key={`${editorSeq}-${selectedKey ?? 'none'}`}
            dbId={dbId}
            detail={editorDetail}
            mode={editorMode}
            onDeleted={() => setEditorMode('cleared')}
          />
        </div>
      </div>

      <div className="card" style={{ marginTop: '24px' }}>
        <Console dbId={dbId} />
      </div>

      {/* ------------------------------ Actions ------------------------------ */}
      <div className="detail-actions">
        <Button
          label="Settings"
          iconName="sliders"
          variant="secondary"
          onClick={() => navigate(`/databases/${dbId}/settings`)}
        />
        <Button
          label="Delete database"
          iconName="trash"
          variant="danger"
          onClick={() => setDeleteConfirm(true)}
        />
      </div>

      {/* ------------------------------- Modals ------------------------------ */}
      <Modal
        open={createKeyOpen}
        title={`API key for "${database.name}"`}
        onClose={() => setCreateKeyOpen(false)}
        actions={(
          <>
            <Button label="Cancel" onClick={() => setCreateKeyOpen(false)} />
            <Button label="Create key" variant="primary" onClick={() => void submitCreateKey()} disabled={createKeyBusy} />
          </>
        )}
      >
        <Field
          ref={keyNameFieldRef}
          id="dbkey-name"
          label="Key name"
          required
          placeholder="e.g. production app, CI pipeline"
          hint="Shown only to you, for identification."
          value={keyName}
          onValueChange={setKeyName}
          validate={validateRequired}
        />
        <div className="field">
          <span>Permission *</span>
          <div className="radio-stack">
            {PERMISSIONS.map((entry, index) => (
              <label
                key={entry.value}
                htmlFor={`dbkey-permission-${index}`}
                className="radio-card"
              >
                <input
                  type="radio"
                  name="dbkey-permission"
                  id={`dbkey-permission-${index}`}
                  value={entry.value}
                  checked={permission === entry.value}
                  onChange={(event) => setPermission(event.target.value)}
                />
                <span>
                  <strong>{entry.label}</strong>
                  <span className="hint">{entry.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="hint">Enforced server-side on every request.</p>
        </div>
        <p className="inline-error" role="alert" hidden={!createKeyError}>{createKeyError}</p>
      </Modal>

      <Modal
        open={revokeConfirm}
        title="Revoke API key"
        onClose={() => setRevokeConfirm(false)}
        actions={(
          <>
            <Button label="Cancel" onClick={() => setRevokeConfirm(false)} />
            <Button
              label="Revoke key"
              variant="danger"
              onClick={() => {
                setRevokeConfirm(false);
                void submitRevoke();
              }}
            />
          </>
        )}
      >
        {activeKey ? (
          <p>{`Anything using "${activeKey.name}" loses access to "${database.name}" immediately. This cannot be undone.`}</p>
        ) : null}
      </Modal>

      <Modal
        open={deleteConfirm}
        title="Delete database"
        onClose={() => setDeleteConfirm(false)}
        actions={(
          <>
            <Button label="Cancel" onClick={() => setDeleteConfirm(false)} />
            <Button
              label="Delete database"
              variant="danger"
              onClick={() => {
                setDeleteConfirm(false);
                void confirmDeleteDatabase();
              }}
            />
          </>
        )}
      >
        <p>{`This deletes "${database.name}" and every key in it. This cannot be undone.`}</p>
      </Modal>

      <PlaintextReveal
        open={reveal.open}
        plaintext={reveal.plaintext}
        onClose={() => setReveal((state) => ({ ...state, open: false }))}
      />
    </div>
  );
}
