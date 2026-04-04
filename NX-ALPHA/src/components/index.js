/**
 * AURA NX-Alpha — Component Exports
 * Clean barrel file. Import from here, not from individual component paths.
 *
 * Usage:
 *   import { Panel, AgentMonitor, CommandCenter } from '../components';
 */

// ── Primitives
export { default as Panel }          from './Panel/Panel';
export { default as StatusBadge }    from './StatusBadge/StatusBadge';
export { default as AuraIndicator }  from './AuraIndicator/AuraIndicator';

// ── Interaction
export { default as Chat }           from './Chat/Chat';

// ── Command Center Panels
export { default as AgentMonitor }   from './AgentMonitor/AgentMonitor';
export { default as SystemStatus }   from './SystemStatus/SystemStatus';
export { default as Schedule }       from './Schedule/Schedule';
export { default as QuickNotes }     from './QuickNotes/QuickNotes';

// ── Layout Shell
export { default as TitleBar }       from './TitleBar/TitleBar';
export { default as AppBar }         from './AppBar/AppBar';
export { default as Canvas }         from './Canvas/Canvas';
export { default as FloatingPanel }  from './FloatingPanel/FloatingPanel';
export { default as DropPanel }      from './DropPanel/DropPanel';
export { default as PeekStack }      from './PeekStack/PeekStack';
export { default as RightDock }      from './RightDock/RightDock';
export { default as CommandCenter }  from './CommandCenter/CommandCenter';

// ── Service Panels
export { default as SettingsPanel }  from './SettingsPanel/SettingsPanel';
export { default as NewsPanel }      from './NewsPanel/NewsPanel';
export { default as FinancePanel }   from './FinancePanel/FinancePanel';
export { default as CalendarPanel }  from './CalendarPanel/CalendarPanel';
export { default as MailPanel }      from './MailPanel/MailPanel';
export { default as CommsPanel }     from './CommsPanel/CommsPanel';

// ── Canvas Block Renderer
export { default as CanvasBlockRenderer } from './CanvasBlockRenderer/CanvasBlockRenderer';
export { default as CanvasBlock }         from './CanvasBlockRenderer/CanvasBlock';
export { BlockContent }                   from './CanvasBlockRenderer/blocks/index';

// ── Interrupt Overlays
export { default as WarningPopup }        from './WarningPopup/WarningPopup';

// ── Conversation History
export { default as ConversationsPanel }  from './ConversationsPanel/ConversationsPanel';
