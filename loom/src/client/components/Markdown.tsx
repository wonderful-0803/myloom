import React from 'react';

/** Render the artifact's supported Markdown as React nodes; source HTML stays text. */
function inline(text: string): React.ReactNode {
  return text.split(/(\x60[^\x60]+\x60|\*\*[^*]+\*\*|\*[^*\n]+\*)/g).map((part, index) => {
    if (/^\x60/.test(part)) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    return part;
  });
}

export function Markdown({ content }: { content: string }) {
  const lines = content.split('\n');
  const nodes: React.ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const key = index;
    if (/^\x60{3}/.test(line)) {
      const language = line.slice(3).trim();
      const body: string[] = [];
      index++;
      while (index < lines.length && !/^\x60{3}/.test(lines[index])) body.push(lines[index++]);
      index++;
      const text = body.join('\n');
      const block = <pre><code>{text}</code></pre>;
      nodes.push(/TAP version|AssertionError|node:internal|ℹ (tests|suites)|^[✔✖]|^(tap|log|text)$/im.test(text + '\n' + language) ? <details className="document-log" key={key}><summary>测试输出 <span>{body.length} 行</span></summary>{block}</details> : <div className={'code-block ' + (language === 'diff' ? 'is-diff' : '')} key={key}>{language && <div className="code-language">{language}</div>}{block}</div>);
      continue;
    }
    if (!line.trim()) { index++; continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { const Tag = ('h' + Math.min(heading[1].length + 1, 4)) as 'h2' | 'h3' | 'h4'; nodes.push(<Tag key={key}>{inline(heading[2])}</Tag>); index++; continue; }
    if (/^\s*[-*]\s/.test(line) || /^\s*\d+[.)]\s/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: React.ReactNode[] = [];
      const pattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/;
      while (index < lines.length && pattern.test(lines[index])) { items.push(<li key={index}>{inline(lines[index++].replace(pattern, ''))}</li>); }
      nodes.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    if (line.startsWith('|') && /^\|?[\s:|-]+\|/.test(lines[index + 1] || '')) {
      const cells = (value: string) => value.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const headings = cells(line); index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].startsWith('|')) rows.push(cells(lines[index++]));
      nodes.push(<div className="document-table" key={key}><table><thead><tr>{headings.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^---+$/.test(line.trim())) nodes.push(<hr key={key} />);
    else if (/^>\s?/.test(line)) nodes.push(<blockquote key={key}>{inline(line.replace(/^>\s?/, ''))}</blockquote>);
    else nodes.push(<p key={key}>{inline(line)}</p>);
    index++;
  }
  return <div className="document-body">{nodes}</div>;
}
