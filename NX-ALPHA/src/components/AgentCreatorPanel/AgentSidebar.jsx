/**
 * AURA NX-Alpha — AgentSidebar
 *
 * Left panel of the Agent Creator. Accordion sections:
 *   My Agents · Node Palette · Skills · Templates · Tool Sources
 *
 * Dragging a palette item sets dataTransfer so the canvas onDrop can
 * create the node at the drop position.
 */

import { useState } from 'react';
import { NODE_PALETTE } from './nodes';
import styles from './AgentSidebar.module.css';

// ─── Accordion section wrapper ───────────────────────────────────────────────

function Section({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={styles.section}>
      <button className={styles.sectionHeader} onClick={() => setOpen(o => !o)}>
        <span>{title}</span>
        <span className={styles.chevron}>{open ? '▴' : '▾'}</span>
      </button>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </div>
  );
}

// ─── GitIngest form ──────────────────────────────────────────────────────────

function GitIngestForm({ onIngestGit }) {
  const [url, setUrl]       = useState('');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError]   = useState(null);

  const handleIngest = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const result = await onIngestGit(url.trim());
      if (result.error) { setError(result.error); }
      else { setPreview(result); }
    } catch (e) {
      setError('Request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.ingestForm}>
      <input
        className={styles.ingestInput}
        placeholder="Paste GitHub URL…"
        value={url}
        onChange={e => setUrl(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && handleIngest()}
      />
      <button className={styles.ingestBtn} onClick={handleIngest} disabled={loading}>
        {loading ? '…' : 'Detect'}
      </button>
      {error && <div className={styles.ingestError}>{error}</div>}
      {preview && (
        <div className={styles.ingestPreview}>
          <div className={styles.ingestType}>{preview.detected_type}</div>
          <div className={styles.ingestSub}>→ {preview.suggested_node_type} node</div>
          <div className={styles.ingestUrl}>{preview.url}</div>
        </div>
      )}
    </div>
  );
}

// ─── MCPServerForm ───────────────────────────────────────────────────────────

function MCPServerForm({ onAddMCP }) {
  const [name, setName]   = useState('');
  const [url, setUrl]     = useState('');
  const [loading, setLoading] = useState(false);

  const handleAdd = async () => {
    if (!name.trim() || !url.trim()) return;
    setLoading(true);
    try {
      await onAddMCP(name.trim(), url.trim());
      setName('');
      setUrl('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.ingestForm}>
      <input
        className={styles.ingestInput}
        placeholder="Server name"
        value={name}
        onChange={e => setName(e.target.value)}
      />
      <input
        className={styles.ingestInput}
        placeholder="URL or package"
        value={url}
        onChange={e => setUrl(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && handleAdd()}
      />
      <button className={styles.ingestBtn} onClick={handleAdd} disabled={loading}>
        {loading ? '…' : 'Connect'}
      </button>
    </div>
  );
}

// ─── AgentSidebar ────────────────────────────────────────────────────────────

export default function AgentSidebar({
  agents = [],
  currentAgentId,
  onSelectAgent,
  onNewAgent,
  skills = [],
  templates = [],
  mcpServers = [],
  onIngestGit,
  onAddMCP,
  onApplyTemplate,
}) {
  const onDragStart = (event, nodeType) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className={styles.sidebar}>

      {/* ── My Agents ── */}
      <Section title="My Agents" defaultOpen>
        <button className={styles.newAgentBtn} onClick={onNewAgent}>+ New Agent</button>
        {agents.length === 0 && (
          <div className={styles.empty}>No agents yet</div>
        )}
        {agents.map(agent => (
          <div
            key={agent.id}
            className={`${styles.agentRow} ${agent.id === currentAgentId ? styles.agentRowActive : ''}`}
            onClick={() => onSelectAgent(agent)}
          >
            <span className={styles.agentName}>{agent.name || 'Untitled'}</span>
            <span className={`${styles.badge} ${agent.published ? styles.badgePublished : styles.badgeDraft}`}>
              {agent.published ? 'live' : 'draft'}
            </span>
          </div>
        ))}
      </Section>

      {/* ── Node Palette ── */}
      <Section title="Node Palette" defaultOpen>
        <div className={styles.palette}>
          {NODE_PALETTE.map(({ type, label, color }) => (
            <div
              key={type}
              className={styles.paletteItem}
              style={{ borderLeftColor: color }}
              draggable
              onDragStart={e => onDragStart(e, type)}
            >
              {label}
            </div>
          ))}
        </div>
      </Section>

      {/* ── Skills ── */}
      <Section title="Skills">
        {skills.length === 0 && <div className={styles.empty}>No skills available</div>}
        {skills.map(skill => (
          <div key={skill.id} className={styles.skillRow}>
            <span className={styles.skillName}>{skill.name}</span>
            <span className={styles.skillDesc}>{skill.description}</span>
          </div>
        ))}
      </Section>

      {/* ── Templates ── */}
      <Section title="Templates">
        {templates.length === 0 && <div className={styles.empty}>No templates available</div>}
        {templates.map(tpl => (
          <div key={tpl.id} className={styles.skillRow} onClick={() => onApplyTemplate?.(tpl)}>
            <span className={styles.skillName}>{tpl.name}</span>
            <span className={styles.skillDesc}>{tpl.description}</span>
          </div>
        ))}
      </Section>

      {/* ── Tool Sources ── */}
      <Section title="Tool Sources">
        <div className={styles.sourceLabel}>GitHub Repo</div>
        <GitIngestForm onIngestGit={onIngestGit} />
        <div className={styles.sourceLabel} style={{ marginTop: 12 }}>MCP Server</div>
        <MCPServerForm onAddMCP={onAddMCP} />
        {mcpServers.length > 0 && (
          <div className={styles.mcpList}>
            {mcpServers.map(s => (
              <div key={s.id ?? s.name} className={styles.mcpRow}>
                <span className={styles.mcpDot} />
                {s.name}
              </div>
            ))}
          </div>
        )}
      </Section>

    </div>
  );
}
