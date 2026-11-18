/** Pure Markdown-to-OOXML renderer. It never reads files, fetches images, evaluates HTML or executes user code. */
import { marked, type Token, type Tokens } from 'marked'
import { AlignmentType, BorderStyle, Document, Footer, HeadingLevel, LevelFormat, PageNumber, Packer, Paragraph,
  Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType, type IRunOptions } from 'docx'

const font = 'Noto Sans CJK SC'
const clean = (text: string) => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
const textRuns = (text: string, style: IRunOptions = {}) => clean(text).split('\n').flatMap((line,i) => [...(i ? [new TextRun({ break: 1 })] : []), new TextRun({ ...style, text: line })])
function inline(tokens: readonly Token[], style: IRunOptions = {}, depth = 0): TextRun[] {
  if (depth > 12) throw new Error('Document nesting exceeds budget')
  return tokens.flatMap(token => {
    if (token.type === 'br') return [new TextRun({ break: 1 })]
    if (token.type === 'html') return [new TextRun({ ...style, text: clean(token.raw) })]
    if (token.type === 'image') return [new TextRun({ ...style, text: `[图片：${clean(token.text || '未嵌入')}；未加载外部资源]` })]
    if (token.type === 'link') return [...inline(token.tokens ?? [], style, depth + 1), new TextRun({ ...style, text: ` (${clean(token.href)})` })]
    if (token.type === 'strong') return inline(token.tokens ?? [], { ...style, bold: true }, depth + 1)
    if (token.type === 'em') return inline(token.tokens ?? [], { ...style, italics: true }, depth + 1)
    if (token.type === 'del') return inline(token.tokens ?? [], { ...style, strike: true }, depth + 1)
    if (token.type === 'codespan') return [new TextRun({ ...style, text: clean(token.text), font: 'DejaVu Sans Mono', size: 19 })]
    if ('tokens' in token && Array.isArray(token.tokens)) return inline(token.tokens ?? [], style, depth + 1)
    return textRuns('text' in token ? String(token.text) : token.raw, style)
  })
}
export async function renderDocx(title: string, body: string): Promise<Buffer> {
  if (!body.trim() || body.length > 40000 || title.length > 500) throw new Error('Document input exceeds budget')
  const tokens = marked.lexer(body, { gfm: true }), levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]
  let count = 0, titleUsed = false, listIndex = 0
  const lists: { reference: string; levels: { level: number; format: typeof LevelFormat.DECIMAL; text: string; alignment: typeof AlignmentType.START }[] }[] = []
  function blocks(items: readonly Token[], depth = 0): (Paragraph | Table)[] {
    if (depth > 10) throw new Error('Document nesting exceeds budget')
    return items.flatMap((token): (Paragraph | Table)[] => {
      if (++count > 4000) throw new Error('Document structure exceeds budget')
      if (token.type === 'space' || token.type === 'def' || token.type === 'hr') return []
      if (token.type === 'heading') {
        const isTitle = !titleUsed && token.depth === 1; if (isTitle) titleUsed = true
        return [new Paragraph({ heading: isTitle ? HeadingLevel.TITLE : levels[Math.min(5, token.depth - 1)], children: inline(token.tokens ?? []), keepNext: true })]
      }
      if (token.type === 'list') {
        const list = token as Tokens.List
        const reference = `list-${++listIndex}`
        if (list.ordered) lists.push({ reference, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START }] })
        return list.items.flatMap((item) => {
          const children = blocks(item.tokens, depth + 1)
          // Keep nested paragraphs and lists; only the first paragraph receives this list marker.
          if (children[0] instanceof Paragraph) {
            const textTokens = item.tokens[0]
            const runs = textTokens && 'tokens' in textTokens && Array.isArray(textTokens.tokens) ? inline(textTokens.tokens) : [new TextRun(clean(item.text))]
            children[0] = new Paragraph({ children: [...(item.task ? [new TextRun(item.checked ? '☑ ' : '☐ ')] : []), ...runs],
              ...(list.ordered ? { numbering: { reference, level: 0, instance: listIndex } } : { bullet: { level: Math.min(depth, 6) } }), spacing: { after: 100 } })
          }
          return children
        })
      }
      if (token.type === 'table') {
        const table = token as Tokens.Table
        if (!table.header.length || table.header.length > 10 || table.rows.length > 200) throw new Error('Document table exceeds budget')
        const n = table.header.length, available = 9638
        const weights = table.header.map((cell, i) => Math.min(32, Math.max(6, clean(cell.text).length * 1.5,
          ...table.rows.map(row => Math.min(32, clean(row[i]?.text || '').length)))))
        const total = weights.reduce((a,b)=>a+b,0), widths = weights.map(w=>Math.floor(available*w/total))
        widths[n-1] = widths[n-1]! + available - widths.reduce((a,b)=>a+b,0)
        const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' }
        const row = (cells: typeof table.header, header: boolean, index: number) => new TableRow({ tableHeader: header, children: cells.map((cell,i) => new TableCell({
          width: { size: widths[i]!, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
          margins: { top: 110, bottom: 110, left: 125, right: 125 }, borders: { top: border, bottom: border, left: border, right: border },
          shading: { fill: header ? 'E8EDF2' : index % 2 ? 'F7F8FA' : 'FFFFFF' },
          children: [new Paragraph({ children: inline(cell.tokens, { bold: header, size: 20, color: '000000' }),
            spacing: { line: 290, after: 40 }, alignment: table.align[i] === 'center' ? AlignmentType.CENTER : table.align[i] === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT })],
        })) })
        return [new Table({ width: { size: available, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED,
          rows: [row(table.header, true, 0), ...table.rows.map((cells,i)=>row(cells,false,i))] }), new Paragraph({ spacing: { after: 80 } })]
      }
      if (token.type === 'blockquote') return blocks(token.tokens ?? [], depth + 1)
      if (token.type === 'code') return [new Paragraph({ children: textRuns(token.text, { font: 'DejaVu Sans Mono', size: 18 }), spacing: { after: 120 } })]
      const runs = 'tokens' in token && Array.isArray(token.tokens) ? inline(token.tokens) : [new TextRun(clean('text' in token ? String(token.text) : token.raw))]
      return [new Paragraph({ children: runs, widowControl: true, spacing: { after: 120, line: 325 } })]
    })
  }
  const children = blocks(tokens)
  if (!titleUsed) children.unshift(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(clean(title))], keepNext: true }))
  const heading = (size: number) => ({ run: { font, size, color: '000000', bold: true }, paragraph: { spacing: { before: 220, after: 120 }, keepNext: true } })
  return Packer.toBuffer(new Document({ creator: 'Loom', title: clean(title), description: 'Loom task report',
    styles: { default: { document: { run: { font, size: 22, color: '000000' }, paragraph: { spacing: { line: 325, after: 120 } } },
      title: heading(36), heading1: heading(29), heading2: heading(25), heading3: heading(23), heading4: heading(22), heading5: heading(22), heading6: heading(22) } },
    numbering: { config: lists }, sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '666666' })] })] }) }, children }] }))
}
