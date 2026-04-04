/**
 * AURA NX-Alpha — Dev Panel
 *
 * Vibe Coding Studio — the Workhorse's dedicated workspace.
 * When Dev Mode is active, the Workhorse (Ollama) is fully dedicated here.
 * Chat input goes STRAIGHT to the Workhorse — no Interface Agent routing.
 *
 * LAYOUT:
 *   Header   — active project, stack badge, branch, autonomy toggle, preview button
 *   Left     — Workhorse Chat (dedicated SSE stream on /dev/stream)
 *   Right    — Task Board (queued/active/done) + File Explorer stub + Git Status stub
 *   Bottom   — Terminal strip (Phase II)
 *
 * PHASE I SCOPE:
 *   - Workhorse Chat with dedicated /dev/stream SSE
 *   - Task Board (task queue from /dev/tasks)
 *   - Project header with open/new project
 *   - Dev Mode activate/deactivate
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import styles from './DevPanel.module.css';

const BACKEND = 'http://localhost:8000';

// ─────────────────────────────────────────────────────────────────────────────
// HOOKS
// ─────────────────────────────────────────────────────────────────────────────

function useDevStream(onEvent) {
  const esRef = useRef(null);

  useEffect(() => {
    const es = new EventSource(`${BACKEND}/dev/stream`);
    esRef.current = es;

    const handler = (e) => {
      try {
        const data = JSON.parse(e.data);
        onEvent(data);
      } catch {
        /* ignore malformed frames */
      }
    };

    // Listen to all named event types we emit from dev_controller
    const events = [
      'dev_thinking', 'token', 'dev_end', 'dev_error',
      'dev_project_loaded', 'dev_terminal_output', 'dev_preview_ready',
    ];
    events.forEach((evt) => es.addEventListener(evt, handler));
    es.addEventListener('message', handler); // catch-all

    return () => {
      events.forEach((evt) => es.removeEventListener(evt, handler));
      es.removeEventListener('message', handler);
      es.close();
    };
  }, [onEvent]);
}

function useDevState() {
  const [devState, setDevState] = useState(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND}/dev/state`);
      if (res.ok) setDevState(await res.json());
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { fetchState(); }, [fetchState]);

  const activate = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND}/dev/activate`, { method: 'POST' });
      if (res.ok) setDevState(await res.json());
    } catch { /* non-fatal */ }
  }, []);

  const deactivate = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND}/dev/deactivate`, { method: 'POST' });
      if (res.ok) setDevState(await res.json());
    } catch { /* non-fatal */ }
  }, []);

  return { devState, activate, deactivate, refresh: fetchState };
}

function useProjectContext() {
  const [context, setContext] = useState(null);
  const [projects, setProjects] = useState([]);

  const fetchContext = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND}/dev/project/context`);
      if (res.ok) setContext(await res.json());
    } catch { /* non-fatal */ }
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND}/dev/project/list`);
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || []);
      }
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    fetchContext();
    fetchProjects();
  }, [fetchContext, fetchProjects]);

  const openProject = useCallback(async (projectId) => {
    try {
      await fetch(`${BACKEND}/dev/project/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      });
      await fetchContext();
    } catch { /* non-fatal */ }
  }, [fetchContext]);

  const newProject = useCallback(async (name, path, stack, deploycmd) => {
    try {
      const res = await fetch(`${BACKEND}/dev/project/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path, stack, deploy_cmd: deploycmd }),
      });
      if (res.ok) {
        await fetchProjects();
        const data = await res.json();
        if (data.project) await openProject(data.project.id);
      }
    } catch { /* non-fatal */ }
  }, [fetchProjects, openProject]);

  return { context, projects, openProject, newProject, refresh: fetchContext };
}

function useTaskQueue(activeProjectId) {
  const [tasks, setTasks] = useState([]);

  const fetchTasks = useCallback(async () => {
    if (!activeProjectId) return;
    try {
      const res = await fetch(`${BACKEND}/dev/tasks`);
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
      }
    } catch { /* non-fatal */ }
  }, [activeProjectId]);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 3000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  return { tasks, refresh: fetchTasks };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const DevHeader = ({ devState, context, projects, onActivate, onDeactivate, onOpenProject, onNewProject }) => {
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newStack, setNewStack] = useState('');

  const project = context?.project;
  const isActive = devState?.active;

  const handleNew = async () => {
    if (!newName || !newPath) return;
    await onNewProject(newName, newPath, newStack, '');
    setShowNewForm(false);
    setNewName(''); setNewPath(''); setNewStack('');
  };

  return (
    <div className={styles.header}>
      <div className={styles.headerLeft}>
        <div className={styles.led} aria-hidden="true" />
        <button
          className={styles.projectName}
          onClick={() => setShowProjectMenu(v => !v)}
          title="Switch project"
        >
          {project ? project.name : 'No Project'}
          <span className={styles.headerChevron}>▾</span>
        </button>
        {project?.stack && (
          <span className={styles.stackBadge}>{project.stack}</span>
        )}
        {showProjectMenu && (
          <div className={styles.projectMenu}>
            {projects.map(p => (
              <button
                key={p.id}
                className={styles.projectMenuItem}
                onClick={() => { onOpenProject(p.id); setShowProjectMenu(false); }}
              >
                <span className={styles.projectMenuName}>{p.name}</span>
                <span className={styles.projectMenuPath}>{p.path}</span>
              </button>
            ))}
            <div className={styles.projectMenuDivider} />
            <button
              className={[styles.projectMenuItem, styles.projectMenuNew].join(' ')}
              onClick={() => { setShowProjectMenu(false); setShowNewForm(true); }}
            >
              + New Project
            </button>
          </div>
        )}
        {showNewForm && (
          <div className={styles.newProjectForm}>
            <input
              className={styles.newProjectInput}
              placeholder="Project name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
            />
            <input
              className={styles.newProjectInput}
              placeholder="Absolute path (e.g. C:/Users/you/myapp)"
              value={newPath}
              onChange={e => setNewPath(e.target.value)}
            />
            <input
              className={styles.newProjectInput}
              placeholder="Stack (e.g. React + FastAPI)"
              value={newStack}
              onChange={e => setNewStack(e.target.value)}
            />
            <div className={styles.newProjectActions}>
              <button className={styles.newProjectSave} onClick={handleNew}>Create</button>
              <button className={styles.newProjectCancel} onClick={() => setShowNewForm(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className={styles.headerRight}>
        <button
          className={[styles.devToggle, isActive && styles.devToggleActive].filter(Boolean).join(' ')}
          onClick={isActive ? onDeactivate : onActivate}
          title={isActive ? 'Deactivate Dev Mode (release Workhorse)' : 'Activate Dev Mode (dedicate Workhorse)'}
        >
          <span className={styles.devToggleIcon}>{isActive ? '⬡' : '</>'}</span>
          {isActive ? 'DEV ACTIVE' : 'ACTIVATE DEV'}
        </button>
      </div>
    </div>
  );
};


const MessageBubble = ({ msg }) => {
  const isUser = msg.role === 'user';
  return (
    <div className={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleWorkhorse].join(' ')}>
      {!isUser && (
        <div className={styles.bubbleLabel}>WORKHORSE</div>
      )}
      <div className={styles.bubbleText}>{msg.content}</div>
    </div>
  );
};


const WorkhorseChat = ({ devState, onSend }) => {
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState('');
  const [thinking, setThinking] = useState(false);
  const currentMsgIdRef = useRef(null);  // ref avoids stale closure in handleEvent
  const scrollRef = useRef(null);

  const handleEvent = useCallback((data) => {
    const { type, text } = data;
    // stream_chat emits messageId (camelCase); dev_thinking emits msg_id (snake_case)
    const eventMsgId = data.msg_id || data.messageId;

    if (type === 'dev_thinking') {
      currentMsgIdRef.current = eventMsgId;
      setThinking(true);
      setMessages(prev => [...prev, { id: eventMsgId, role: 'assistant', content: '' }]);
    } else if (type === 'token' && eventMsgId === currentMsgIdRef.current) {
      setMessages(prev => prev.map(m =>
        m.id === currentMsgIdRef.current ? { ...m, content: m.content + (text || '') } : m
      ));
    } else if (type === 'dev_end') {
      setThinking(false);
      currentMsgIdRef.current = null;
    } else if (type === 'dev_error') {
      setThinking(false);
      currentMsgIdRef.current = null;
      setMessages(prev => [...prev, {
        id: `err-${Date.now()}`,
        role: 'error',
        content: data.message || 'Workhorse error.',
      }]);
    }
  }, []);  // stable — uses ref, no stale closure

  useDevStream(handleEvent);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || thinking) return;
    setInput('');
    setMessages(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', content: text }]);
    await onSend(text);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const isDevActive = devState?.active;

  return (
    <div className={styles.chat}>
      <div className={styles.chatMessages} ref={scrollRef}>
        {messages.length === 0 && (
          <div className={styles.chatEmpty}>
            {isDevActive
              ? 'Workhorse ready. Describe what you want to build.'
              : 'Activate Dev Mode to connect to the Workhorse.'}
          </div>
        )}
        {messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
        {thinking && (
          <div className={styles.thinking}>
            <span className={styles.thinkingDot} />
            <span className={styles.thinkingDot} />
            <span className={styles.thinkingDot} />
          </div>
        )}
      </div>
      <form className={styles.chatForm} onSubmit={handleSubmit}>
        <textarea
          className={styles.chatInput}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isDevActive ? 'Talk to the Workhorse...' : 'Activate Dev Mode first'}
          disabled={!isDevActive || thinking}
          rows={3}
        />
        <button
          type="submit"
          className={styles.chatSend}
          disabled={!isDevActive || thinking || !input.trim()}
          aria-label="Send to Workhorse"
        >
          ⬡
        </button>
      </form>
    </div>
  );
};


const TaskStatusBadge = ({ status }) => {
  const labels = { queued: 'QUEUED', active: 'ACTIVE', done: 'DONE', cancelled: 'CANCELLED' };
  return (
    <span className={[styles.taskBadge, styles[`taskBadge_${status}`]].join(' ')}>
      {labels[status] || status.toUpperCase()}
    </span>
  );
};


const TaskBoard = ({ tasks }) => {
  const columns = ['queued', 'active', 'done'];
  const byStatus = Object.fromEntries(
    columns.map(s => [s, tasks.filter(t => t.status === s)])
  );

  return (
    <div className={styles.taskBoard}>
      <div className={styles.sideLabel}>TASK BOARD</div>
      {columns.map(col => (
        <div key={col} className={styles.taskColumn}>
          <div className={styles.taskColumnHeader}>
            {col.toUpperCase()} <span className={styles.taskCount}>{byStatus[col].length}</span>
          </div>
          {byStatus[col].map(task => (
            <div key={task.id} className={styles.taskCard}>
              <div className={styles.taskDesc}>{task.description}</div>
              {task.agent_step && (
                <div className={styles.taskStep}>{task.agent_step}</div>
              )}
              <TaskStatusBadge status={task.status} />
            </div>
          ))}
          {byStatus[col].length === 0 && (
            <div className={styles.taskEmpty}>—</div>
          )}
        </div>
      ))}
    </div>
  );
};


// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

const DevPanel = () => {
  const { devState, activate, deactivate } = useDevState();
  const { context, projects, openProject, newProject } = useProjectContext();
  const activeProjectId = context?.project?.id ?? null;
  const { tasks } = useTaskQueue(activeProjectId);

  const sendMessage = useCallback(async (text) => {
    try {
      await fetch(`${BACKEND}/dev/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch { /* non-fatal — dev_error will surface via SSE */ }
  }, []);

  return (
    <div className={styles.panel}>

      <DevHeader
        devState={devState}
        context={context}
        projects={projects}
        onActivate={activate}
        onDeactivate={deactivate}
        onOpenProject={openProject}
        onNewProject={newProject}
      />

      <div className={styles.body}>

        {/* ── LEFT: Workhorse Chat ── */}
        <div className={styles.chatPane}>
          <WorkhorseChat devState={devState} onSend={sendMessage} />
        </div>

        {/* ── RIGHT: Task Board + stubs ── */}
        <div className={styles.sidePane}>
          <TaskBoard tasks={tasks} />

          <div className={styles.sideSection}>
            <div className={styles.sideLabel}>FILE EXPLORER</div>
            <div className={styles.stub}>
              {activeProjectId
                ? `Project: ${context?.project?.name}`
                : 'Open a project to browse files'}
              <div className={styles.stubNote}>Full file tree — Phase II</div>
            </div>
          </div>

          <div className={styles.sideSection}>
            <div className={styles.sideLabel}>GIT STATUS</div>
            <div className={styles.stub}>
              {activeProjectId ? 'Git panel — Phase II' : 'Open a project first'}
              <div className={styles.stubNote}>Branch · Staged · Commits</div>
            </div>
          </div>
        </div>

      </div>

      {/* ── BOTTOM: Terminal strip — Phase II ── */}
      <div className={styles.terminalStrip}>
        <div className={styles.terminalLabel}>TERMINAL</div>
        <div className={styles.terminalStub}>Interactive terminal — Phase II</div>
      </div>

    </div>
  );
};

export default DevPanel;
