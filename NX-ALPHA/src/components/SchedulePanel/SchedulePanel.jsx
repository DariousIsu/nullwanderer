/**
 * AURA NX-Alpha — SchedulePanel
 *
 * Scheduled Tasks management panel. Two-column layout: sidebar + main.
 * Sidebar: Active tasks list, pending approval section.
 * Main: Task detail view, edit/reschedule/pause controls, job history.
 * Task creation form with name, type, schedule picker, recipients.
 *
 * TASK SHAPE:
 * {
 *   task_id:       string,
 *   name:          string,
 *   task_type:     string,
 *   schedule:      string,      — cron: "0 8 * * MON"
 *   parameters:    object,
 *   sender_email:  string,
 *   recipient_list: string[],
 *   status:        'active' | 'paused' | 'archived',
 *   source:        'internal' | 'portal_request',
 *   created_at:    string,
 *   last_run:      string | null,
 *   next_run:      string | null,
 *   notes:         string,
 * }
 */

import { useState, useEffect, useCallback } from 'react';
import styles from './SchedulePanel.module.css';
import {
  useTasks,
  createTask,
  updateTask,
  deleteTask,
  runTaskNow,
  fetchTaskHistory,
} from '../../hooks/useBackendData';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const TASK_TYPES = [
  { value: 'legislative_digest', label: 'Legislative Digest' },
  { value: 'news_brief',        label: 'News Brief' },
  { value: 'internal_schedule', label: 'Schedule Digest' },
  { value: 'data_pull',         label: 'Data Pull' },
  { value: 'report',            label: 'Custom Report' },
];

const CRON_PRESETS = [
  { label: 'Every Monday 8 AM',    value: '0 8 * * MON' },
  { label: 'Weekdays 9 AM',        value: '0 9 * * MON-FRI' },
  { label: 'Daily 7 AM',           value: '0 7 * * *' },
  { label: 'Every 6 hours',        value: '0 */6 * * *' },
  { label: 'First of month 9 AM',  value: '0 9 1 * *' },
  { label: 'Custom',               value: '' },
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '--';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function formatCron(cron) {
  const preset = CRON_PRESETS.find(p => p.value === cron);
  return preset && preset.value ? preset.label : cron;
}

function typeLabel(type) {
  const t = TASK_TYPES.find(tt => tt.value === type);
  return t ? t.label : type;
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE FORM
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_FORM = {
  name: '',
  task_type: 'news_brief',
  schedule: '0 8 * * MON',
  customCron: '',
  sender_email: '',
  recipients: '',
  notes: '',
};

function CreateForm({ onSubmit, onCancel }) {
  const [form, setForm] = useState(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleChange = (field) => (e) => {
    setForm(prev => ({ ...prev, [field]: e.target.value }));
    setError(null);
  };

  const handlePreset = (e) => {
    const val = e.target.value;
    if (val === '') {
      setForm(prev => ({ ...prev, schedule: '', customCron: prev.customCron }));
    } else {
      setForm(prev => ({ ...prev, schedule: val, customCron: '' }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const schedule = form.schedule || form.customCron;
    if (!schedule) { setError('Schedule is required'); setSubmitting(false); return; }
    if (!form.name.trim()) { setError('Name is required'); setSubmitting(false); return; }

    try {
      const recipientList = form.recipients
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      await onSubmit({
        name: form.name.trim(),
        task_type: form.task_type,
        schedule,
        sender_email: form.sender_email.trim(),
        recipient_list: recipientList,
        notes: form.notes.trim(),
        parameters: {},
      });
    } catch (err) {
      setError(err.message || 'Failed to create task');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <div className={styles.formGroup}>
        <label className={styles.formLabel}>Task Name</label>
        <input
          className={styles.formInput}
          value={form.name}
          onChange={handleChange('name')}
          placeholder="e.g. Weekly News Digest"
          autoFocus
        />
      </div>

      <div className={styles.formRow}>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Type</label>
          <select
            className={styles.formSelect}
            value={form.task_type}
            onChange={handleChange('task_type')}
          >
            {TASK_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Schedule</label>
          <select
            className={styles.formSelect}
            value={form.schedule || ''}
            onChange={handlePreset}
          >
            {CRON_PRESETS.map(p => (
              <option key={p.label} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
      </div>

      {!form.schedule && (
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Custom Cron (5-field)</label>
          <input
            className={styles.formInput}
            value={form.customCron}
            onChange={handleChange('customCron')}
            placeholder="0 8 * * MON-FRI"
          />
        </div>
      )}

      <div className={styles.formGroup}>
        <label className={styles.formLabel}>Sender Email (optional)</label>
        <input
          className={styles.formInput}
          value={form.sender_email}
          onChange={handleChange('sender_email')}
          placeholder="your.email@gmail.com"
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.formLabel}>Recipients (comma-separated)</label>
        <input
          className={styles.formInput}
          value={form.recipients}
          onChange={handleChange('recipients')}
          placeholder="user@example.com, other@example.com"
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.formLabel}>Notes</label>
        <textarea
          className={styles.formTextarea}
          value={form.notes}
          onChange={handleChange('notes')}
          placeholder="Optional notes about this task..."
        />
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.formActions}>
        <button
          type="submit"
          className={`${styles.actionBtn} ${styles.actionBtn_accent}`}
          disabled={submitting}
        >
          {submitting ? 'Creating...' : 'Create Task'}
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TASK DETAIL
// ─────────────────────────────────────────────────────────────────────────────

function TaskDetail({ task, onRefresh }) {
  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const res = await fetchTaskHistory(task.task_id);
      setHistory(res.history || []);
    } catch {
      setHistory([]);
    } finally {
      setLoadingHistory(false);
    }
  }, [task.task_id]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const handleAction = async (action) => {
    setActionLoading(action);
    try {
      if (action === 'run-now')  await runTaskNow(task.task_id);
      if (action === 'pause')    await fetch(`http://127.0.0.1:8000/data/tasks/${task.task_id}/pause`, { method: 'POST' });
      if (action === 'resume')   await fetch(`http://127.0.0.1:8000/data/tasks/${task.task_id}/resume`, { method: 'POST' });
      if (action === 'delete')   await deleteTask(task.task_id);
      onRefresh();
      if (action === 'run-now') setTimeout(loadHistory, 3000);
    } catch (err) {
      console.error(`Task action ${action} failed:`, err);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <>
      <div className={styles.mainHeader}>
        <div className={styles.mainTitle}>{task.name}</div>
        <div className={styles.mainActions}>
          {task.status === 'active' && (
            <>
              <button
                className={`${styles.actionBtn} ${styles.actionBtn_accent}`}
                onClick={() => handleAction('run-now')}
                disabled={!!actionLoading}
              >
                {actionLoading === 'run-now' ? 'Running...' : 'Run Now'}
              </button>
              <button
                className={styles.actionBtn}
                onClick={() => handleAction('pause')}
                disabled={!!actionLoading}
              >
                Pause
              </button>
            </>
          )}
          {task.status === 'paused' && (
            <button
              className={`${styles.actionBtn} ${styles.actionBtn_accent}`}
              onClick={() => handleAction('resume')}
              disabled={!!actionLoading}
            >
              Resume
            </button>
          )}
          {task.status !== 'archived' && (
            <button
              className={`${styles.actionBtn} ${styles.actionBtn_danger}`}
              onClick={() => handleAction('delete')}
              disabled={!!actionLoading}
            >
              Archive
            </button>
          )}
        </div>
      </div>

      <div className={styles.mainContent}>
        <div className={styles.detailGrid}>
          <div className={styles.detailLabel}>Status</div>
          <div className={styles.detailValue}>
            <span className={`${styles.statusBadge} ${styles[`statusBadge_${task.status}`]}`}>
              {task.status}
            </span>
          </div>

          <div className={styles.detailLabel}>Type</div>
          <div className={styles.detailValue}>
            <span className={styles.typeBadge}>{typeLabel(task.task_type)}</span>
          </div>

          <div className={styles.detailLabel}>Schedule</div>
          <div className={styles.detailValue}>{formatCron(task.schedule)}</div>

          <div className={styles.detailLabel}>Cron</div>
          <div className={styles.detailValue} style={{ fontFamily: 'monospace' }}>{task.schedule}</div>

          <div className={styles.detailLabel}>Next Run</div>
          <div className={styles.detailValue}>{formatDate(task.next_run)}</div>

          <div className={styles.detailLabel}>Last Run</div>
          <div className={styles.detailValue}>{formatDate(task.last_run)}</div>

          <div className={styles.detailLabel}>Created</div>
          <div className={styles.detailValue}>{formatDate(task.created_at)}</div>

          <div className={styles.detailLabel}>Source</div>
          <div className={styles.detailValue}>{task.source}</div>

          {task.sender_email && (
            <>
              <div className={styles.detailLabel}>Sender</div>
              <div className={styles.detailValue}>{task.sender_email}</div>
            </>
          )}

          {task.recipient_list && task.recipient_list.length > 0 && (
            <>
              <div className={styles.detailLabel}>Recipients</div>
              <div className={styles.detailValue}>{task.recipient_list.join(', ')}</div>
            </>
          )}

          {task.notes && (
            <>
              <div className={styles.detailLabel}>Notes</div>
              <div className={styles.detailValue}>{task.notes}</div>
            </>
          )}
        </div>

        {/* Job History */}
        <div className={styles.historySection}>
          <div className={styles.historyTitle}>Execution History</div>
          {loadingHistory ? (
            <div className={styles.loading}>Loading history...</div>
          ) : history.length === 0 ? (
            <div className={styles.emptyState}>No executions yet</div>
          ) : (
            <table className={styles.historyTable}>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Finished</th>
                  <th>Status</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.log_id}>
                    <td>{formatDate(h.started_at)}</td>
                    <td>{formatDate(h.finished_at)}</td>
                    <td className={styles[`historyStatus_${h.status}`] || ''}>
                      {h.status}
                    </td>
                    <td title={h.error || h.result_summary || ''}>
                      {h.error || h.result_summary || '--'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PANEL
// ─────────────────────────────────────────────────────────────────────────────

export default function SchedulePanel() {
  const { data, loading, error, refresh } = useTasks(30000);
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);

  const tasks = data?.tasks || [];
  const activeTasks  = tasks.filter(t => t.status === 'active');
  const pausedTasks  = tasks.filter(t => t.status === 'paused');

  const selectedTask = tasks.find(t => t.task_id === selectedId);

  const handleCreate = async (taskData) => {
    await createTask(taskData);
    setCreating(false);
    refresh();
  };

  const handleSelect = (taskId) => {
    setCreating(false);
    setSelectedId(taskId);
  };

  if (loading && !data) {
    return <div className={styles.loading}>Loading scheduled tasks...</div>;
  }

  return (
    <div className={styles.container}>
      {/* ── Sidebar ────────────────────────────────────────────────────────── */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span className={styles.sidebarTitle}>Scheduled Tasks</span>
          <button className={styles.addButton} onClick={() => { setCreating(true); setSelectedId(null); }}>
            + New
          </button>
        </div>

        {/* Active */}
        <div className={styles.sidebarSection}>
          <div className={styles.sectionLabel}>Active ({activeTasks.length})</div>
          <div className={styles.taskList}>
            {activeTasks.map(t => (
              <div
                key={t.task_id}
                className={`${styles.taskItem} ${selectedId === t.task_id ? styles.taskItemActive : ''}`}
                onClick={() => handleSelect(t.task_id)}
              >
                <div className={styles.taskName}>{t.name}</div>
                <div className={styles.taskMeta}>
                  <span className={`${styles.statusDot} ${styles.statusDot_active}`} />
                  {typeLabel(t.task_type)}
                  <span style={{ marginLeft: 'auto', fontSize: 10 }}>
                    {formatCron(t.schedule)}
                  </span>
                </div>
              </div>
            ))}
            {activeTasks.length === 0 && (
              <div className={styles.emptyState}>No active tasks</div>
            )}
          </div>
        </div>

        {/* Paused */}
        {pausedTasks.length > 0 && (
          <div className={styles.sidebarSection}>
            <div className={styles.sectionLabel}>Paused ({pausedTasks.length})</div>
            <div className={styles.taskList}>
              {pausedTasks.map(t => (
                <div
                  key={t.task_id}
                  className={`${styles.taskItem} ${selectedId === t.task_id ? styles.taskItemActive : ''}`}
                  onClick={() => handleSelect(t.task_id)}
                >
                  <div className={styles.taskName}>{t.name}</div>
                  <div className={styles.taskMeta}>
                    <span className={`${styles.statusDot} ${styles.statusDot_paused}`} />
                    {typeLabel(t.task_type)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Main ───────────────────────────────────────────────────────────── */}
      <div className={styles.main}>
        {creating ? (
          <>
            <div className={styles.mainHeader}>
              <div className={styles.mainTitle}>Create Scheduled Task</div>
            </div>
            <div className={styles.mainContent}>
              <CreateForm
                onSubmit={handleCreate}
                onCancel={() => setCreating(false)}
              />
            </div>
          </>
        ) : selectedTask ? (
          <TaskDetail task={selectedTask} onRefresh={refresh} />
        ) : (
          <div className={styles.emptyMain}>
            <div className={styles.emptyIcon}>&#x23F0;</div>
            <div>Select a task or create a new one</div>
          </div>
        )}
      </div>
    </div>
  );
}
