/**
 * ChartBlock — recharts wrapper for bar, line, and pie charts.
 * Tab selector to switch chart type. AURA color palette applied.
 *
 * Data shape:
 *   {
 *     chartType?: 'bar'|'line'|'pie',
 *     title?:     string,
 *     labels:     string[],           // x-axis labels / pie slice names
 *     series:     { name: string, data: number[] }[]
 *   }
 *
 * Requires recharts. Install: npm install recharts
 */
import { useState } from 'react';
import {
  BarChart,  Bar,
  LineChart, Line,
  PieChart,  Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import styles from './blocks.module.css';
import chartStyles from './ChartBlock.module.css';

// AURA data palette — matches design tokens
const DATA_COLORS = ['#3D87A8', '#D99030', '#38A85C', '#9B7EC8', '#D05C5C'];

const CHART_TYPES = ['bar', 'line', 'pie'];

// Tooltip styled for dark theme
const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className={chartStyles.tooltip}>
      {label && <div className={chartStyles.tooltipLabel}>{label}</div>}
      {payload.map((entry, i) => (
        <div key={i} className={chartStyles.tooltipRow}>
          <span className={chartStyles.tooltipDot} style={{ background: entry.color }} />
          <span className={chartStyles.tooltipName}>{entry.name}:</span>
          <span className={chartStyles.tooltipValue}>{entry.value}</span>
        </div>
      ))}
    </div>
  );
};

const ChartBlock = ({
  chartType: initialType = 'bar',
  title     = '',
  labels    = [],
  series    = [],
}) => {
  const [activeType, setActiveType] = useState(initialType);

  // Transform flat labels + series into recharts data format
  const data = labels.map((label, i) => {
    const point = { label };
    series.forEach(s => { point[s.name] = s.data?.[i] ?? 0; });
    return point;
  });

  // Pie data uses first series only
  const pieData = labels.map((label, i) => ({
    name:  label,
    value: series[0]?.data?.[i] ?? 0,
  }));

  const axisStyle = {
    fontFamily: 'var(--font-mono)',
    fontSize:   10,
    fill:       'var(--text-tertiary)',
  };

  const gridStyle = { stroke: 'rgba(31,45,64,0.6)', strokeDasharray: '3 3' };

  const renderChart = () => {
    if (activeType === 'pie') {
      return (
        <PieChart>
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius="70%"
            strokeWidth={0}
          >
            {pieData.map((_, i) => (
              <Cell key={i} fill={DATA_COLORS[i % DATA_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)' }}
          />
        </PieChart>
      );
    }

    const ChartComponent = activeType === 'line' ? LineChart : BarChart;

    return (
      <ChartComponent data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid {...gridStyle} />
        <XAxis dataKey="label" tick={axisStyle} axisLine={false} tickLine={false} />
        <YAxis tick={axisStyle} axisLine={false} tickLine={false} />
        <Tooltip content={<CustomTooltip />} />
        {series.length > 1 && (
          <Legend wrapperStyle={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)' }} />
        )}
        {series.map((s, i) => (
          activeType === 'line'
            ? <Line
                key={s.name}
                type="monotone"
                dataKey={s.name}
                stroke={DATA_COLORS[i % DATA_COLORS.length]}
                strokeWidth={2}
                dot={{ r: 3, fill: DATA_COLORS[i % DATA_COLORS.length] }}
                activeDot={{ r: 4 }}
              />
            : <Bar
                key={s.name}
                dataKey={s.name}
                fill={DATA_COLORS[i % DATA_COLORS.length]}
                radius={[2, 2, 0, 0]}
                maxBarSize={32}
              />
        ))}
      </ChartComponent>
    );
  };

  return (
    <div className={`${styles.root} ${styles.rootBleed}`} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Chart type tabs + optional title */}
      <div className={chartStyles.header}>
        {title && <span className={chartStyles.chartTitle}>{title}</span>}
        <div className={chartStyles.typeTabs}>
          {CHART_TYPES.map(t => (
            <button
              key={t}
              className={`${chartStyles.typeTab} ${activeType === t ? chartStyles.typeTabActive : ''}`}
              onClick={() => setActiveType(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div style={{ flex: 1, minHeight: 0, padding: '8px 8px 4px' }}>
        {data.length > 0 || pieData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            {renderChart()}
          </ResponsiveContainer>
        ) : (
          <div className={styles.empty}>No data</div>
        )}
      </div>
    </div>
  );
};

export default ChartBlock;
