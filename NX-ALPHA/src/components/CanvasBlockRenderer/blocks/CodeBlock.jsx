/**
 * CodeBlock — syntax-highlighted code display.
 * JetBrains Mono, copy-to-clipboard button, language label.
 * Lightweight regex tokenizer — no external syntax library required.
 *
 * Data shape: { language?: string, code: string }
 */
import { useState, useMemo } from 'react';
import styles from './blocks.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// LIGHTWEIGHT SYNTAX TOKENIZER
// Handles: keywords, strings, comments, numbers, function calls.
// Good enough for display; not a full parser.
// ─────────────────────────────────────────────────────────────────────────────

const KEYWORDS = new Set([
  // JS / TS
  'const','let','var','function','return','if','else','for','while','do',
  'switch','case','break','continue','class','new','this','import','export',
  'default','from','async','await','typeof','instanceof','null','undefined',
  'true','false','try','catch','finally','throw','delete','void','in','of',
  // Python
  'def','lambda','pass','yield','with','as','raise','except','elif',
  'and','or','not','is','None','True','False','global','nonlocal',
]);

function tokenize(code) {
  const tokens = [];
  let i = 0;
  while (i < code.length) {
    // Multi-line comment /* ... */
    if (code[i] === '/' && code[i+1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const text = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      tokens.push({ type: 'comment', text });
      i += text.length;
      continue;
    }
    // Line comment // ...
    if (code[i] === '/' && code[i+1] === '/') {
      const end = code.indexOf('\n', i);
      const text = end === -1 ? code.slice(i) : code.slice(i, end);
      tokens.push({ type: 'comment', text });
      i += text.length;
      continue;
    }
    // Python/shell line comment #
    if (code[i] === '#') {
      const end = code.indexOf('\n', i);
      const text = end === -1 ? code.slice(i) : code.slice(i, end);
      tokens.push({ type: 'comment', text });
      i += text.length;
      continue;
    }
    // String: " ' `
    if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
      const q = code[i];
      let j = i + 1;
      while (j < code.length && code[j] !== q) {
        if (code[j] === '\\') j++; // escape
        j++;
      }
      tokens.push({ type: 'string', text: code.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    // Number
    if (/[0-9]/.test(code[i]) && (i === 0 || !/[a-zA-Z_$]/.test(code[i-1]))) {
      let j = i;
      while (j < code.length && /[0-9._xXbBoO]/.test(code[j])) j++;
      tokens.push({ type: 'number', text: code.slice(i, j) });
      i = j;
      continue;
    }
    // Identifier or keyword
    if (/[a-zA-Z_$]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[a-zA-Z0-9_$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      // Check if followed by ( — function call
      const isCall = code[j] === '(';
      const type = KEYWORDS.has(word) ? 'keyword' : isCall ? 'function' : 'plain';
      tokens.push({ type, text: word });
      i = j;
      continue;
    }
    // Operator characters
    if (/[+\-*/%=<>!&|^~?:;,.()\[\]{}]/.test(code[i])) {
      tokens.push({ type: 'operator', text: code[i] });
      i++;
      continue;
    }
    // Everything else (whitespace, newlines)
    tokens.push({ type: 'plain', text: code[i] });
    i++;
  }
  return tokens;
}

const TOKEN_CLASSES = {
  keyword:  styles.tokenKeyword,
  string:   styles.tokenString,
  comment:  styles.tokenComment,
  number:   styles.tokenNumber,
  function: styles.tokenFunction,
  operator: styles.tokenOperator,
  plain:    '',
};

// ─────────────────────────────────────────────────────────────────────────────
// CODE BLOCK
// ─────────────────────────────────────────────────────────────────────────────

const CodeBlock = ({ language = '', code = '' }) => {
  const [copied, setCopied] = useState(false);

  const tokens = useMemo(() => tokenize(code), [code]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback for non-HTTPS / Electron without clipboard perms
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <div className={`${styles.root} ${styles.rootBleed}`} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header: language label + copy button */}
      <div className={styles.codeHeader}>
        <span className={styles.codeLang}>{language || 'code'}</span>
        <button
          className={`${styles.codeCopyBtn} ${copied ? styles.codeCopied : ''}`}
          onClick={handleCopy}
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>

      {/* Code body */}
      <div className={styles.codeBody}>
        {tokens.map((token, i) => (
          token.type === 'plain'
            ? <span key={i}>{token.text}</span>
            : <span key={i} className={TOKEN_CLASSES[token.type]}>{token.text}</span>
        ))}
      </div>
    </div>
  );
};

export default CodeBlock;
