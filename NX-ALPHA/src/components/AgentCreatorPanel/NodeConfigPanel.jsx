/**
 * AURA NX-Alpha — NodeConfigPanel
 *
 * Right panel rendered when a node is selected on the canvas.
 * Switches on node.type to render type-specific config fields.
 * Calls onChange(changes) on every field update.
 */

import styles from './NodeConfigPanel.module.css';

// ─── Shared field components ─────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      {children}
    </div>
  );
}

function TextInput({ value, placeholder, onChange }) {
  return (
    <input
      className={styles.input}
      value={value ?? ''}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
    />
  );
}

function TextArea({ value, placeholder, onChange, rows = 4 }) {
  return (
    <textarea
      className={styles.textarea}
      value={value ?? ''}
      placeholder={placeholder}
      rows={rows}
      onChange={e => onChange(e.target.value)}
    />
  );
}

function Select({ value, options, onChange }) {
  return (
    <select className={styles.select} value={value ?? ''} onChange={e => onChange(e.target.value)}>
      {options.map(o => (
        <option key={o.value ?? o} value={o.value ?? o}>
          {o.label ?? o}
        </option>
      ))}
    </select>
  );
}

function Slider({ value, min, max, step = 0.1, onChange }) {
  return (
    <div className={styles.sliderRow}>
      <input
        type="range"
        className={styles.slider}
        min={min} max={max} step={step}
        value={value ?? min}
        onChange={e => onChange(Number(e.target.value))}
      />
      <span className={styles.sliderVal}>{(value ?? min).toFixed(1)}</span>
    </div>
  );
}

// ─── Type-specific config panels ─────────────────────────────────────────────

function LLMConfig({ data, onChange, availableTools }) {
  return (
    <>
      <Field label="Model">
        <TextInput value={data.model} placeholder="llama3" onChange={v => onChange({ model: v })} />
      </Field>
      <Field label="Temperature">
        <Slider value={data.temperature} min={0} max={2} step={0.05} onChange={v => onChange({ temperature: v })} />
      </Field>
      <Field label="System Prompt">
        <TextArea value={data.system_prompt} placeholder="You are…" rows={5} onChange={v => onChange({ system_prompt: v })} />
      </Field>
    </>
  );
}

function ToolConfig({ data, onChange, availableTools = [] }) {
  return (
    <>
      <Field label="Tool">
        <Select
          value={data.tool_id}
          options={[
            { value: '', label: '— Select tool —' },
            ...availableTools.map(t => ({ value: t.id ?? t.name, label: t.name })),
          ]}
          onChange={v => onChange({ tool_id: v })}
        />
      </Field>
      {data.tool_id && (
        <Field label="Params (JSON)">
          <TextArea
            value={typeof data.params === 'object' ? JSON.stringify(data.params, null, 2) : data.params}
            placeholder="{}"
            rows={4}
            onChange={v => {
              try { onChange({ params: JSON.parse(v) }); }
              catch { /* keep editing */ }
            }}
          />
        </Field>
      )}
    </>
  );
}

function ConditionConfig({ data, onChange }) {
  return (
    <>
      <Field label="Expression">
        <TextInput value={data.expression} placeholder="result.score > 0.8" onChange={v => onChange({ expression: v })} />
      </Field>
      <Field label="True Branch Label">
        <TextInput value={data.true_label} placeholder="true" onChange={v => onChange({ true_label: v })} />
      </Field>
      <Field label="False Branch Label">
        <TextInput value={data.false_label} placeholder="false" onChange={v => onChange({ false_label: v })} />
      </Field>
    </>
  );
}

function TriggerConfig({ data, onChange }) {
  // Simple human-readable hint for common cron patterns
  const hints = {
    '0 * * * *':   'Every hour',
    '0 9 * * *':   'Daily at 9am',
    '0 9 * * 1':   'Weekly Mon 9am',
    '*/5 * * * *': 'Every 5 minutes',
    '0 0 * * *':   'Daily at midnight',
  };
  const hint = hints[data.cron] ?? '';

  return (
    <>
      <Field label="Cron Expression">
        <TextInput value={data.cron} placeholder="0 * * * *" onChange={v => onChange({ cron: v })} />
      </Field>
      {hint && <div className={styles.hint}>{hint}</div>}
    </>
  );
}

function MemoryReadConfig({ data, onChange }) {
  return (
    <>
      <Field label="Query Key">
        <TextInput value={data.query_key} placeholder="query" onChange={v => onChange({ query_key: v })} />
      </Field>
      <Field label="Limit">
        <Slider value={data.limit} min={1} max={50} step={1} onChange={v => onChange({ limit: v })} />
      </Field>
    </>
  );
}

function MemoryWriteConfig({ data, onChange }) {
  return (
    <Field label="Source Label">
      <TextInput value={data.source_label} placeholder="agent_output" onChange={v => onChange({ source_label: v })} />
    </Field>
  );
}

function OutputConfig({ data, onChange }) {
  return (
    <Field label="Format">
      <Select
        value={data.format}
        options={['text', 'json', 'markdown', 'html']}
        onChange={v => onChange({ format: v })}
      />
    </Field>
  );
}

function ResearcherConfig({ data, onChange }) {
  return (
    <Field label="Query Key">
      <TextInput value={data.query_key} placeholder="query" onChange={v => onChange({ query_key: v })} />
    </Field>
  );
}

function BrowserConfig({ data, onChange }) {
  return (
    <>
      <Field label="Action">
        <Select
          value={data.action}
          options={['navigate', 'click', 'extract', 'screenshot', 'fill']}
          onChange={v => onChange({ action: v })}
        />
      </Field>
      <Field label="URL / Selector">
        <TextInput value={data.url} placeholder="https://…" onChange={v => onChange({ url: v })} />
      </Field>
    </>
  );
}

function CodeExecConfig({ data, onChange }) {
  return (
    <>
      <Field label="Language">
        <Select
          value={data.language}
          options={['python', 'javascript', 'bash']}
          onChange={v => onChange({ language: v })}
        />
      </Field>
      <Field label="Code">
        <TextArea value={data.code} placeholder="# code…" rows={8} onChange={v => onChange({ code: v })} />
      </Field>
    </>
  );
}

function SkillGroupConfig({ data, onChange, skills = [] }) {
  return (
    <Field label="Skill">
      <Select
        value={data.skill_id}
        options={[
          { value: '', label: '— Select skill —' },
          ...skills.map(s => ({ value: s.id, label: s.name })),
        ]}
        onChange={v => onChange({ skill_id: v })}
      />
    </Field>
  );
}

// ─── NodeConfigPanel ─────────────────────────────────────────────────────────

const TYPE_LABELS = {
  llm:          'LLM',
  tool:         'Tool',
  condition:    'Condition',
  trigger:      'Trigger',
  memory_read:  'Memory Read',
  memory_write: 'Memory Write',
  output:       'Output',
  researcher:   'Researcher',
  browser:      'Browser',
  code_exec:    'Code Exec',
  skill_group:  'Skill Group',
};

export default function NodeConfigPanel({ node, availableTools = [], skills = [], onChange }) {
  if (!node) return null;
  const { type, data } = node;

  const handleChange = (changes) => onChange?.(node.id, changes);

  const renderConfig = () => {
    switch (type) {
      case 'llm':          return <LLMConfig         data={data} onChange={handleChange} availableTools={availableTools} />;
      case 'tool':         return <ToolConfig        data={data} onChange={handleChange} availableTools={availableTools} />;
      case 'condition':    return <ConditionConfig   data={data} onChange={handleChange} />;
      case 'trigger':      return <TriggerConfig     data={data} onChange={handleChange} />;
      case 'memory_read':  return <MemoryReadConfig  data={data} onChange={handleChange} />;
      case 'memory_write': return <MemoryWriteConfig data={data} onChange={handleChange} />;
      case 'output':       return <OutputConfig      data={data} onChange={handleChange} />;
      case 'researcher':   return <ResearcherConfig  data={data} onChange={handleChange} />;
      case 'browser':      return <BrowserConfig     data={data} onChange={handleChange} />;
      case 'code_exec':    return <CodeExecConfig    data={data} onChange={handleChange} />;
      case 'skill_group':  return <SkillGroupConfig  data={data} onChange={handleChange} skills={skills} />;
      default:             return <div className={styles.unknown}>No config for type: {type}</div>;
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.typeLabel}>{TYPE_LABELS[type] ?? type}</span>
        <span className={styles.nodeId}>{node.id.slice(0, 8)}</span>
      </div>
      <div className={styles.body}>
        {renderConfig()}
      </div>
    </div>
  );
}
