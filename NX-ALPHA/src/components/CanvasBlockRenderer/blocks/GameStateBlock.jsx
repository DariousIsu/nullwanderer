/**
 * GameStateBlock — live game state display for Gymnasium / AgentGym sessions.
 *
 * Renders a terminal-style scoreboard that updates each step as AURA plays.
 * Uses existing code block CSS classes so no new styles are needed.
 *
 * Data shape:
 *   env_name:     string   — "CartPole-v1"
 *   step:         number   — current step number
 *   action_taken: number   — action index chosen by AURA
 *   action_label: string   — human-readable action name
 *   reward:       number   — reward from last step
 *   total_reward: number   — cumulative reward
 *   observation:  string   — stringified observation vector
 *   status:       string   — "running" | "done" | "error"
 */
import styles from './blocks.module.css';

const STATUS_COLOR = {
  running: 'var(--blue-bright)',
  done:    'var(--status-complete)',
  error:   'var(--status-error)',
};

const GameStateBlock = ({
  env_name     = 'Unknown',
  step         = 0,
  action_taken = -1,
  action_label = '—',
  reward       = 0,
  total_reward = 0,
  observation  = '',
  status       = 'running',
}) => {
  const statusColor = STATUS_COLOR[status] || 'var(--text-tertiary)';

  return (
    <div className={`${styles.root} ${styles.rootBleed}`} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div className={styles.codeHeader}>
        <span className={styles.codeLang}>{env_name}</span>
        <span style={{
          fontFamily:    'var(--font-condensed)',
          fontSize:      9,
          fontWeight:    600,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color:         statusColor,
        }}>
          {status === 'running' ? `Step ${step}` : status.toUpperCase()}
        </span>
      </div>

      {/* Scoreboard row */}
      <div style={{
        display:       'flex',
        gap:           24,
        padding:       '8px 14px',
        background:    'rgba(6, 10, 18, 0.60)',
        borderBottom:  '1px solid var(--bg-rule)',
        flexShrink:    0,
      }}>
        <ScoreItem label="Step"    value={step} />
        <ScoreItem label="Reward"  value={reward >= 0 ? `+${reward.toFixed(1)}` : reward.toFixed(1)} color={reward >= 0 ? 'var(--status-complete)' : 'var(--status-error)'} />
        <ScoreItem label="Total"   value={total_reward.toFixed(1)} />
      </div>

      {/* Action line */}
      <div style={{
        padding:    '5px 14px',
        fontFamily: 'var(--font-mono)',
        fontSize:   10,
        color:      'var(--text-tertiary)',
        borderBottom: '1px solid var(--bg-rule)',
        flexShrink: 0,
      }}>
        {action_taken >= 0
          ? <>AURA chose <span style={{ color: 'var(--amber-bright)' }}>action {action_taken}</span> — {action_label}</>
          : status === 'done' ? 'Game complete' : 'Waiting…'
        }
      </div>

      {/* Observation dump */}
      <div className={styles.codeBody} style={{ overflow: 'auto', fontSize: 10 }}>
        {observation || '—'}
      </div>
    </div>
  );
};

const ScoreItem = ({ label, value, color }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
    <span style={{
      fontFamily:    'var(--font-condensed)',
      fontSize:      8,
      fontWeight:    600,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color:         'var(--text-tertiary)',
    }}>
      {label}
    </span>
    <span style={{
      fontFamily: 'var(--font-mono)',
      fontSize:   13,
      fontWeight: 600,
      color:      color || 'var(--text-primary)',
    }}>
      {value}
    </span>
  </div>
);

export default GameStateBlock;
