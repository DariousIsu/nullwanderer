/**
 * AURA NX-Alpha — AgentCreatorPanel
 *
 * Three-column visual node canvas for building custom agents.
 *   Left  → AgentSidebar  (agent list, node palette, tool sources)
 *   Center → ReactFlow canvas
 *   Right  → NodeConfigPanel (selected node config)
 *
 * Bottom strip: collapsible SSE run-log drawer.
 *
 * Drag-to-canvas: palette items set dataTransfer type → canvas onDrop reads it,
 * creates node at drop position via useReactFlow().screenToFlowPosition().
 */

import { useCallback } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useAgentCreator, defaultNodeData } from '../../hooks/useAgentCreator';
import { nodeTypes }    from './nodes';
import AgentSidebar     from './AgentSidebar';
import AgentToolbar     from './AgentToolbar';
import NodeConfigPanel  from './NodeConfigPanel';
import styles           from './AgentCreatorPanel.module.css';

// ─── SSE event colors ────────────────────────────────────────────────────────

const EVENT_COLOR = {
  start:         '#4a6070',
  node_start:    '#b87820',
  node_complete: '#2ab87a',
  complete:      '#2ab87a',
  error:         '#e05a5a',
};

// ─── Run log drawer ──────────────────────────────────────────────────────────

function RunDrawer({ log, isRunning, open, onToggle }) {
  return (
    <div className={`${styles.drawer} ${open ? styles.drawerOpen : ''}`}>
      <button className={styles.drawerToggle} onClick={onToggle}>
        {open ? '▾' : '▴'} Run Output
        {isRunning && <span className={styles.runPulse} />}
      </button>
      {open && (
        <div className={styles.drawerLog}>
          {log.length === 0 && <span className={styles.logEmpty}>No output yet.</span>}
          {log.map((entry, i) => (
            <div key={i} className={styles.logLine}>
              <span
                className={styles.logEvent}
                style={{ color: EVENT_COLOR[entry.event] ?? '#8aa0b4' }}
              >
                {entry.event}
              </span>
              {entry.node_id && (
                <span className={styles.logNodeId}> [{entry.node_id.slice(0, 8)}]</span>
              )}
              {entry.type && (
                <span className={styles.logType}> {entry.type}</span>
              )}
              {entry.message && (
                <span className={styles.logMessage}> — {entry.message}</span>
              )}
              {entry.result && (
                <span className={styles.logResult}> ✓ complete</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Canvas inner (needs ReactFlowProvider context for useReactFlow) ─────────

function CanvasInner({
  nodes, edges,
  onNodesChange, onEdgesChange, onConnect,
  setNodes,
  setSelectedNode,
  updateNodeData,
  availableTools, skills,
  selectedNode,
}) {
  const { screenToFlowPosition } = useReactFlow();

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback((event) => {
    event.preventDefault();
    const nodeType = event.dataTransfer.getData('application/reactflow');
    if (!nodeType) return;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const newNode = {
      id:       crypto.randomUUID(),
      type:     nodeType,
      position,
      data:     defaultNodeData(nodeType),
    };
    setNodes(nds => [...nds, newNode]);
  }, [screenToFlowPosition, setNodes]);

  return (
    <div className={styles.canvasWrap}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => setSelectedNode(node)}
        onPaneClick={() => setSelectedNode(null)}
        nodeTypes={nodeTypes}
        onDragOver={onDragOver}
        onDrop={onDrop}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="rgba(31,45,64,0.4)" gap={20} size={1} />
        <Controls
          showInteractive={false}
          className={styles.rfControls}
        />
        <MiniMap
          nodeColor={(n) => {
            const map = {
              llm: '#b87820', tool: '#2a7ab8', condition: '#7a2ab8',
              trigger: '#b85a20', memory_read: '#2ab87a', memory_write: '#2ab87a',
              output: '#b82a2a', researcher: '#7ab82a', browser: '#7ab82a',
              code_exec: '#7ab82a', skill_group: '#2ab8b8',
            };
            return map[n.type] ?? '#4a6070';
          }}
          style={{ background: 'rgba(5,10,18,0.80)', border: '1px solid rgba(31,45,64,0.60)' }}
        />
      </ReactFlow>
      {selectedNode && (
        <NodeConfigPanel
          node={selectedNode}
          availableTools={availableTools}
          skills={skills}
          onChange={updateNodeData}
        />
      )}
    </div>
  );
}

// ─── AgentCreatorPanel ───────────────────────────────────────────────────────

export default function AgentCreatorPanel() {
  const ac = useAgentCreator();

  return (
    <ReactFlowProvider>
      <div className={styles.panel}>

        {/* ── Top toolbar ── */}
        <AgentToolbar
          agent={ac.currentAgent}
          compileError={ac.compileError}
          onSave={ac.saveAgent}
          onPublish={ac.publishAgent}
          onRun={ac.runAgent}
          onUpdateMeta={ac.updateAgentMeta}
        />

        {/* ── Body (sidebar + canvas) ── */}
        <div className={styles.body}>
          <AgentSidebar
            agents={ac.agents}
            currentAgentId={ac.currentAgent?.id}
            onSelectAgent={ac.setCurrentAgent}
            onNewAgent={ac.newAgent}
            skills={ac.skills}
            templates={ac.templates}
            mcpServers={ac.mcpServers}
            onIngestGit={ac.ingestGitRepo}
            onAddMCP={ac.addMCPServer}
            onApplyTemplate={ac.applyTemplate}
          />

          <CanvasInner
            nodes={ac.nodes}
            edges={ac.edges}
            onNodesChange={ac.onNodesChange}
            onEdgesChange={ac.onEdgesChange}
            onConnect={ac.onConnect}
            setNodes={ac.setNodes}
            setSelectedNode={ac.setSelectedNode}
            updateNodeData={ac.updateNodeData}
            availableTools={ac.availableTools}
            skills={ac.skills}
            selectedNode={ac.selectedNode}
          />
        </div>

        {/* ── SSE run-log drawer ── */}
        <RunDrawer
          log={ac.runLog}
          isRunning={ac.isRunning}
          open={ac.runDrawerOpen}
          onToggle={() => ac.setRunDrawerOpen(o => !o)}
        />

      </div>
    </ReactFlowProvider>
  );
}
