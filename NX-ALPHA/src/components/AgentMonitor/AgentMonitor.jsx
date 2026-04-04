/**
 * AURA NX-Alpha — AgentMonitor
 *
 * Real-time agent status panel. Shows what the team is doing right now.
 * This is mission control: every active agent, their current task,
 * progress, and status — at a glance.
 *
 * VARIANT: command — heavy chassis, segmented borders.
 * This is a primary panel. It announces itself.
 *
 * PROPS:
 * agents        — array of agent objects (see AgentShape below)
 * onAgentClick  — optional: called with agent id when a row is clicked
 *
 * AGENT SHAPE:
 * {
 *   id:       string,
 *   name:     string,                          — display name (stenciled uppercase)
 *   task:     string,                          — current task description
 *   status:   'working' | 'waiting' | 'done' | 'idle' | 'fault',
 *   progress: number (0-100) | null,           — shown as bar if provided
 *   elapsed:  string | null,                   — elapsed time string e.g. "2m 14s"
 *   teamId:   string | null,                   — if set, groups under team header
 *   teamName: string | null,                   — team display name (used on first member)
 * }
 */

import { useMemo } from 'react';
import Panel from '../Panel/Panel';
import StatusBadge from '../StatusBadge/StatusBadge';
import styles from './AgentMonitor.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// STATUS → BADGE INTENT MAPPING
// ─────────────────────────────────────────────────────────────────────────────

const statusToBadge = {
  working: 'working',
  waiting: 'waiting',
  done:    'done',
  idle:    'idle',
  fault:   'error',
};

// ─────────────────────────────────────────────────────────────────────────────
// TEAM STATUS DERIVATION
// ─────────────────────────────────────────────────────────────────────────────

function deriveTeamStatus(members) {
  if (members.some(a => a.status === 'fault'))   return 'fault';
  if (members.some(a => a.status === 'working')) return 'working';
  if (members.some(a => a.status === 'waiting')) return 'waiting';
  if (members.every(a => a.status === 'done'))   return 'done';
  return 'idle';
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT ROW
// ─────────────────────────────────────────────────────────────────────────────

const AgentRow = ({ agent, onClick, indented = false }) => {
  const barClass = [
    styles.bar,
    styles[`bar_${agent.status}`],
  ].join(' ');

  return (
    <div
      className={`${styles.row} ${indented ? styles.rowIndented : ''}`}
      onClick={() => onClick?.(agent.id)}
      role="row"
      aria-label={`${agent.name}: ${agent.status}`}
    >
      {/* Status bar — left edge, color-coded */}
      <div className={barClass} aria-hidden="true" />

      {/* Agent info */}
      <div className={styles.info}>
        <div className={styles.nameRow}>
          <span className={styles.name}>{agent.name}</span>
          {agent.elapsed && (
            <span className={styles.elapsed}>{agent.elapsed}</span>
          )}
        </div>
        <div className={styles.task}>{agent.task}</div>

        {/* Progress bar — only when progress is provided */}
        {agent.progress != null && (
          <div className={styles.progressTrack} aria-hidden="true">
            <div
              className={`${styles.progressFill} ${styles[`progress_${agent.status}`]}`}
              style={{ width: `${Math.max(0, Math.min(100, agent.progress))}%` }}
            />
          </div>
        )}
      </div>

      {/* Status badge */}
      <div className={styles.badge}>
        <StatusBadge
          status={statusToBadge[agent.status] ?? 'idle'}
          label={agent.status}
        />
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// TEAM CARD
// Group of agents sharing a teamId, displayed under a team header row.
// ─────────────────────────────────────────────────────────────────────────────

const TeamCard = ({ teamName, teamStatus, members, elapsed, onClick }) => {
  const headerBarClass = `${styles.bar} ${styles[`bar_${teamStatus}`]}`;

  return (
    <div className={styles.teamCard} role="rowgroup" aria-label={`Team: ${teamName}`}>
      {/* Team header row */}
      <div className={styles.teamHeader}>
        <div className={headerBarClass} aria-hidden="true" />
        <div className={styles.info}>
          <div className={styles.nameRow}>
            <span className={styles.teamName}>{teamName}</span>
            {elapsed && (
              <span className={styles.elapsed}>{elapsed}</span>
            )}
          </div>
          <div className={styles.task}>
            {members.length} agent{members.length !== 1 ? 's' : ''}
          </div>
        </div>
        <div className={styles.badge}>
          <StatusBadge
            status={statusToBadge[teamStatus] ?? 'idle'}
            label={teamStatus}
          />
        </div>
      </div>

      {/* Member agent rows — indented */}
      <div className={styles.teamMembers}>
        {members.map((agent, i) => (
          <AgentRow
            key={agent.id ?? `member-${i}`}
            agent={agent}
            onClick={onClick}
            indented
          />
        ))}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// EMPTY STATE
// ─────────────────────────────────────────────────────────────────────────────

const EmptyState = () => (
  <div className={styles.empty}>
    <div className={styles.emptyLabel}>No agents active</div>
    <div className={styles.emptyMeta}>Standing by</div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// AGENT MONITOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Footer content showing counts and last heartbeat.
 * Rendered as Panel footer — gets the glass footer treatment automatically.
 */
const AgentMonitorFooter = ({ agents, lastHeartbeat }) => {
  const active = agents.filter(a => a.status === 'working' || a.status === 'waiting').length;
  const faults = agents.filter(a => a.status === 'fault').length;

  return (
    <div className={styles.footer}>
      <div className={styles.footerCounts}>
        <span className={styles.footerCount}>
          <span className={styles.footerCountValue} data-active={active > 0}>
            {active}
          </span>
          <span className={styles.footerCountLabel}>active</span>
        </span>
        {faults > 0 && (
          <span className={styles.footerCount}>
            <span className={styles.footerCountValue} data-fault="true">
              {faults}
            </span>
            <span className={styles.footerCountLabel}>fault</span>
          </span>
        )}
        <span className={styles.footerCount}>
          <span className={styles.footerCountValue}>
            {agents.filter(a => a.status === 'done').length}
          </span>
          <span className={styles.footerCountLabel}>done</span>
        </span>
      </div>
      {lastHeartbeat && (
        <span className={styles.heartbeat}>
          {lastHeartbeat}
        </span>
      )}
    </div>
  );
};

/**
 * Header extra — live agent count badge rendered in the panel header.
 */
const AgentCount = ({ total }) => (
  <div className={styles.headerCount}>{total}</div>
);


const AgentMonitor = ({
  agents        = [],
  lastHeartbeat = null,
  isActive      = false,
  onAgentClick,
  onPopOut,
}) => {
  // ── GROUPING ──
  // Agents with teamId are grouped under team cards.
  // Agents without teamId render as standalone rows.
  const { standalone, teams } = useMemo(() => {
    const _standalone = [];
    const _teamMap = new Map();   // teamId → { name, elapsed, members[] }

    for (const agent of agents) {
      if (!agent.teamId) {
        _standalone.push(agent);
        continue;
      }

      if (!_teamMap.has(agent.teamId)) {
        _teamMap.set(agent.teamId, {
          teamId:  agent.teamId,
          name:    agent.teamName || agent.teamId,
          elapsed: agent.elapsed ?? null,
          members: [],
        });
      }
      _teamMap.get(agent.teamId).members.push(agent);
    }

    return { standalone: _standalone, teams: Array.from(_teamMap.values()) };
  }, [agents]);

  return (
    <Panel
      title="Agent Monitor"
      variant="command"
      isActive={isActive}
      onPopOut={onPopOut}
      headerExtra={<AgentCount total={agents.length} />}
      footer={<AgentMonitorFooter agents={agents} lastHeartbeat={lastHeartbeat} />}
    >
      {agents.length === 0 ? (
        <EmptyState />
      ) : (
        <div className={styles.list} role="table" aria-label="Agent status list">
          {/* Standalone agents (no team) */}
          {standalone.map((agent, i) => (
            <AgentRow
              key={agent.id ?? `standalone-${i}`}
              agent={agent}
              onClick={onAgentClick}
            />
          ))}

          {/* Team groups */}
          {teams.map(team => (
            <TeamCard
              key={team.teamId}
              teamName={team.name}
              teamStatus={deriveTeamStatus(team.members)}
              members={team.members}
              elapsed={team.elapsed}
              onClick={onAgentClick}
            />
          ))}
        </div>
      )}
    </Panel>
  );
};

export default AgentMonitor;
