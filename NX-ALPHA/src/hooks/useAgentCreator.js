/**
 * AURA NX-Alpha — useAgentCreator
 *
 * Central state for the Agent Creator Panel.
 * Manages agent list, canvas nodes/edges, tool catalogue, MCP servers,
 * and all API interactions against POST/PUT /agents/custom/...
 */

import { useState, useEffect, useCallback } from 'react';
import { useNodesState, useEdgesState, addEdge } from '@xyflow/react';

const API = 'http://localhost:8000';

// ─── Default node data per type ──────────────────────────────────────────────

export function defaultNodeData(type) {
  switch (type) {
    case 'llm':          return { model: 'llama3', temperature: 0.7, system_prompt: '' };
    case 'tool':         return { tool_id: '', params: {} };
    case 'condition':    return { expression: '', true_label: 'true', false_label: 'false' };
    case 'trigger':      return { cron: '0 * * * *' };
    case 'memory_read':  return { limit: 10, query_key: '' };
    case 'memory_write': return { source_label: '' };
    case 'output':       return { format: 'text' };
    case 'researcher':   return { query_key: 'query' };
    case 'browser':      return { url: '', action: 'navigate' };
    case 'code_exec':    return { language: 'python', code: '' };
    case 'skill_group':  return { skill_id: '' };
    default:             return {};
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAgentCreator() {
  const [agents, setAgents]           = useState([]);
  const [currentAgent, setCurrentAgentState] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNode, setSelectedNode]  = useState(null);
  const [availableTools, setAvailableTools] = useState([]);
  const [skills, setSkills]           = useState([]);
  const [templates, setTemplates]     = useState([]);
  const [mcpServers, setMCPServers]   = useState([]);

  // SSE run state
  const [runLog, setRunLog]           = useState([]);
  const [isRunning, setIsRunning]     = useState(false);
  const [runDrawerOpen, setRunDrawerOpen] = useState(false);

  // Publish error state
  const [compileError, setCompileError] = useState(null);

  // ── Load catalogue on mount ──────────────────────────────────────────────
  useEffect(() => {
    fetch(`${API}/agents/custom`).then(r => r.json()).then(setAgents).catch(() => {});
    fetch(`${API}/agents/custom/tools`).then(r => r.json()).then(setAvailableTools).catch(() => {});
    fetch(`${API}/agents/custom/skills`).then(r => r.json()).then(setSkills).catch(() => {});
    fetch(`${API}/agents/custom/templates`).then(r => r.json()).then(setTemplates).catch(() => {});
    fetch(`${API}/agents/custom/mcp/servers`).then(r => r.json()).then(setMCPServers).catch(() => {});
  }, []);

  // ── Select agent → load canvas ───────────────────────────────────────────
  const setCurrentAgent = useCallback((agent) => {
    setCurrentAgentState(agent);
    setSelectedNode(null);
    setCompileError(null);
    if (agent) {
      setNodes((agent.nodes ?? []).map(n => ({
        id: n.id, type: n.type, position: n.position, data: n.data,
      })));
      setEdges((agent.edges ?? []).map(e => ({
        id: e.id, source: e.source, target: e.target,
        sourceHandle: e.source_handle ?? null,
        targetHandle: e.target_handle ?? null,
      })));
    } else {
      setNodes([]);
      setEdges([]);
    }
  }, [setNodes, setEdges]);

  // ── New blank agent ───────────────────────────────────────────────────────
  const newAgent = useCallback(() => {
    setCurrentAgentState({ id: null, name: 'Untitled Agent', category: 'general', published: false });
    setNodes([]);
    setEdges([]);
    setSelectedNode(null);
    setCompileError(null);
  }, [setNodes, setEdges]);

  // ── Connect edges ─────────────────────────────────────────────────────────
  const onConnect = useCallback(
    (params) => setEdges(eds => addEdge(params, eds)),
    [setEdges],
  );

  // ── Update node data (called by NodeConfigPanel) ──────────────────────────
  const updateNodeData = useCallback((nodeId, changes) => {
    setNodes(nds => nds.map(n =>
      n.id === nodeId ? { ...n, data: { ...n.data, ...changes } } : n,
    ));
    // Keep selectedNode in sync
    setSelectedNode(prev =>
      prev?.id === nodeId ? { ...prev, data: { ...prev.data, ...changes } } : prev,
    );
  }, [setNodes]);

  // ── Update agent meta (name/category) ────────────────────────────────────
  const updateAgentMeta = useCallback((changes) => {
    setCurrentAgentState(a => a ? { ...a, ...changes } : a);
  }, []);

  // ── Save draft ───────────────────────────────────────────────────────────
  const saveAgent = useCallback(async () => {
    if (!currentAgent) return null;
    const body = {
      ...currentAgent,
      nodes: nodes.map(n => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
      edges: edges.map(e => ({
        id: e.id, source: e.source, target: e.target,
        source_handle: e.sourceHandle ?? null,
        target_handle: e.targetHandle ?? null,
      })),
    };
    const method = currentAgent.id ? 'PUT' : 'POST';
    const url    = currentAgent.id
      ? `${API}/agents/custom/${currentAgent.id}`
      : `${API}/agents/custom`;
    const res  = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const saved = await res.json();
    setCurrentAgentState(saved);
    setAgents(prev => [...prev.filter(a => a.id !== saved.id), saved]);
    setCompileError(null);
    return saved;
  }, [currentAgent, nodes, edges]);

  // ── Publish ──────────────────────────────────────────────────────────────
  const publishAgent = useCallback(async () => {
    if (!currentAgent) return;
    const saved = await saveAgent();
    if (!saved?.id) return;
    const res = await fetch(`${API}/agents/custom/${saved.id}/publish`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Publish failed' }));
      setCompileError(err.detail ?? 'Compile error');
      return;
    }
    setCompileError(null);
    setCurrentAgentState(a => ({ ...a, published: true }));
    setAgents(prev => prev.map(a => a.id === saved.id ? { ...a, published: true } : a));
  }, [currentAgent, saveAgent]);

  // ── Run (SSE) ────────────────────────────────────────────────────────────
  const runAgent = useCallback(async () => {
    if (!currentAgent?.id) return;
    setRunLog([]);
    setIsRunning(true);
    setRunDrawerOpen(true);
    const es = new EventSource(`${API}/agents/custom/${currentAgent.id}/run`);
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        setRunLog(log => [...log, event]);
        if (event.event === 'complete' || event.event === 'error') {
          setIsRunning(false);
          es.close();
        }
      } catch {
        // non-JSON line, ignore
      }
    };
    es.onerror = () => {
      setRunLog(log => [...log, { event: 'error', message: 'Connection lost' }]);
      setIsRunning(false);
      es.close();
    };
  }, [currentAgent]);

  // ── Git ingestion ────────────────────────────────────────────────────────
  const ingestGitRepo = useCallback(async (url) => {
    const res = await fetch(`${API}/agents/custom/ingest/git`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    return res.json();
  }, []);

  // ── MCP server ───────────────────────────────────────────────────────────
  const addMCPServer = useCallback(async (name, urlOrPackage) => {
    const res = await fetch(`${API}/agents/custom/mcp/servers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url_or_package: urlOrPackage }),
    });
    const server = await res.json();
    setMCPServers(prev => [...prev, server]);
    fetch(`${API}/agents/custom/tools`).then(r => r.json()).then(setAvailableTools).catch(() => {});
    return server;
  }, []);

  // ── Apply template (replace canvas) ──────────────────────────────────────
  const applyTemplate = useCallback((template) => {
    setCurrentAgentState(a => ({ ...a, name: template.name ?? a?.name ?? 'Untitled Agent' }));
    setNodes((template.nodes ?? []).map(n => ({
      id: n.id, type: n.type, position: n.position, data: n.data,
    })));
    setEdges((template.edges ?? []).map(e => ({
      id: e.id, source: e.source, target: e.target,
      sourceHandle: e.source_handle ?? null,
      targetHandle: e.target_handle ?? null,
    })));
    setSelectedNode(null);
  }, [setNodes, setEdges]);

  return {
    // agent list
    agents, currentAgent, newAgent, setCurrentAgent, updateAgentMeta,
    // canvas
    nodes, edges, onNodesChange, onEdgesChange, onConnect,
    setNodes, setEdges,
    // node selection + config
    selectedNode, setSelectedNode, updateNodeData,
    // save / publish
    saveAgent, publishAgent, compileError,
    // run / SSE
    runAgent, runLog, isRunning, runDrawerOpen, setRunDrawerOpen,
    // catalogue
    availableTools, skills, templates,
    // external tool sources
    ingestGitRepo, mcpServers, addMCPServer,
    // template
    applyTemplate,
  };
}
