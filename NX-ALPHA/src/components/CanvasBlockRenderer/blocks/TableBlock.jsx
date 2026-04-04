/**
 * TableBlock — sortable data table. JetBrains Mono cells.
 * Click column headers to sort ascending/descending.
 *
 * Data shape: { columns: string[], rows: string[][] }
 */
import { useState, useMemo } from 'react';
import styles from './blocks.module.css';

const TableBlock = ({ columns = [], rows = [] }) => {
  const [sortCol, setSortCol]  = useState(null);
  const [sortDir, setSortDir]  = useState('asc');

  const handleSort = (colIdx) => {
    if (sortCol === colIdx) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(colIdx);
      setSortDir('asc');
    }
  };

  const sortedRows = useMemo(() => {
    if (sortCol === null) return rows;
    return [...rows].sort((a, b) => {
      const av = a[sortCol] ?? '';
      const bv = b[sortCol] ?? '';
      // Try numeric sort, fall back to string
      const an = parseFloat(av), bn = parseFloat(bv);
      const numeric = !isNaN(an) && !isNaN(bn);
      const cmp = numeric ? an - bn : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sortCol, sortDir]);

  if (!columns.length) {
    return <div className={`${styles.root} ${styles.empty}`}>No data</div>;
  }

  return (
    <div className={`${styles.root} ${styles.rootBleed}`}>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((col, i) => (
                <th
                  key={i}
                  className={`${styles.th} ${sortCol === i ? styles.thSorted : ''}`}
                  onClick={() => handleSort(i)}
                >
                  {col}
                  {sortCol === i && (
                    <span className={styles.thSortIcon}>
                      {sortDir === 'asc' ? '↑' : '↓'}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, ri) => (
              <tr key={ri} className={styles.trHover}>
                {columns.map((_, ci) => (
                  <td key={ci} className={styles.td}>
                    {row[ci] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default TableBlock;
