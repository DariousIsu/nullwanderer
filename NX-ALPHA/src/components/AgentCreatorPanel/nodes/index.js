import { LLMNode }        from './LLMNode';
import { ToolNode }       from './ToolNode';
import { ConditionNode }  from './ConditionNode';
import { TriggerNode }    from './TriggerNode';
import { MemoryNode }     from './MemoryNode';
import { OutputNode }     from './OutputNode';
import { ResearcherNode } from './ResearcherNode';
import { BrowserNode }    from './BrowserNode';
import { CodeExecNode }   from './CodeExecNode';
import { SkillGroupNode } from './SkillGroupNode';

export const nodeTypes = {
  llm:          LLMNode,
  tool:         ToolNode,
  condition:    ConditionNode,
  trigger:      TriggerNode,
  memory_read:  MemoryNode,
  memory_write: MemoryNode,
  output:       OutputNode,
  researcher:   ResearcherNode,
  browser:      BrowserNode,
  code_exec:    CodeExecNode,
  skill_group:  SkillGroupNode,
};

// Node palette — displayed in AgentSidebar for drag-to-canvas
export const NODE_PALETTE = [
  { type: 'trigger',      label: 'Trigger',      color: '#b85a20' },
  { type: 'llm',          label: 'LLM',          color: '#b87820' },
  { type: 'tool',         label: 'Tool',         color: '#2a7ab8' },
  { type: 'condition',    label: 'Condition',    color: '#7a2ab8' },
  { type: 'memory_read',  label: 'Memory Read',  color: '#2ab87a' },
  { type: 'memory_write', label: 'Memory Write', color: '#2ab87a' },
  { type: 'researcher',   label: 'Researcher',   color: '#7ab82a' },
  { type: 'browser',      label: 'Browser',      color: '#7ab82a' },
  { type: 'code_exec',    label: 'Code Exec',    color: '#7ab82a' },
  { type: 'skill_group',  label: 'Skill Group',  color: '#2ab8b8' },
  { type: 'output',       label: 'Output',       color: '#b82a2a' },
];
