/**
 * AURA NX-Alpha — Tool Developer Workspace
 *
 * Full-pipeline panel for creating, training, optimizing, and publishing MCP tools.
 *
 * LAYOUT:
 *   Left sidebar nav (180px) — Dashboard | Dataset Library | Tool Builder | My MCPs
 *   Right main content — active section
 *
 * SECTIONS:
 *   Dashboard      — pipeline kanban + dataset health + stats
 *   Dataset Library — category list + record browser
 *   Tool Builder   — 7-station pipeline (Intake → Publish)
 *   My MCPs        — published tool management
 */

import { useState, useCallback } from 'react';
import styles from './ToolWorkspacePanel.module.css';
import Dashboard      from './Dashboard';
import DatasetLibrary from './DatasetLibrary';
import ToolBuilder    from './ToolBuilder';
import MyMCPs         from './MyMCPs';

// ─────────────────────────────────────────────────────────────────────────────
// NAV ITEMS
// ─────────────────────────────────────────────────────────────────────────────

const NAV = [
  { id: 'dashboard', label: 'Dashboard'       },
  { id: 'dataset',   label: 'Dataset Library' },
  { id: 'builder',   label: 'Tool Builder'    },
  { id: 'mcps',      label: 'My MCPs'         },
];

// ─────────────────────────────────────────────────────────────────────────────
// PANEL
// ─────────────────────────────────────────────────────────────────────────────

const ToolWorkspacePanel = () => {
  const [activeNav,     setActiveNav]     = useState('dashboard');
  const [selectedTool,  setSelectedTool]  = useState(null);
  const [builderActive, setBuilderActive] = useState(false);

  const handleSelectTool = useCallback((tool) => {
    setSelectedTool(tool);
    setBuilderActive(true);
    setActiveNav('builder');
  }, []);

  const handleNewTool = useCallback(() => {
    setSelectedTool(null);
    setBuilderActive(true);
    setActiveNav('builder');
  }, []);

  const handleBuilderBack = useCallback(() => {
    setBuilderActive(false);
    setSelectedTool(null);
    setActiveNav('dashboard');
  }, []);

  const handleNavClick = useCallback((id) => {
    if (id !== 'builder') {
      setBuilderActive(false);
    }
    setActiveNav(id);
  }, []);

  return (
    <div className={styles.container}>
      {/* Left navigation sidebar */}
      <div className={styles.nav}>
        <div className={styles.navHeader}>Tool Workspace</div>
        {NAV.map(item => (
          <div
            key={item.id}
            className={`${styles.navItem} ${activeNav === item.id ? styles.navItemActive : ''}`}
            onClick={() => handleNavClick(item.id)}
          >
            <span className={styles.navDot} />
            {item.label}
          </div>
        ))}
        <div style={{ marginTop: 'auto', padding: '12px 14px', borderTop: '1px solid var(--border, #1a2332)' }}>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={handleNewTool}
          >
            + New Tool
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className={styles.main}>
        {activeNav === 'dashboard' && (
          <Dashboard onSelectTool={handleSelectTool} />
        )}
        {activeNav === 'dataset' && (
          <DatasetLibrary />
        )}
        {activeNav === 'builder' && (
          builderActive ? (
            <ToolBuilder initialTool={selectedTool} onBack={handleBuilderBack} />
          ) : (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>Tool Builder</span>
              </div>
              <div className={styles.empty}>
                <span className={styles.emptyIcon}>⬡</span>
                <span>Click "+ New Tool" to start building, or select a tool from the Dashboard.</span>
              </div>
            </div>
          )
        )}
        {activeNav === 'mcps' && (
          <MyMCPs onSelectTool={handleSelectTool} />
        )}
      </div>
    </div>
  );
};

export default ToolWorkspacePanel;
