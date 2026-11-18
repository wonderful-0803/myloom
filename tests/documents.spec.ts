import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { generateDocument, fileHash } from '../src/documents.ts'
const JSZip = createRequire(import.meta.resolve('docx'))('jszip')

it('creates actual OOXML with Chinese headings, tables and references without fetching or embedding source URLs', async () => {
  const body = '# 会议纪要\n\n记录来源：R1\n整理日期：2026-11-06\n\n## 决定\n\n**周五**完成原型。[S1 00:12]\n\n| 事项 | 负责人 |\n|---|---|\n| 整理说明 | 待确认 |\n\n1. 核对字段\n2. 复核结果\n\n![测试](file:///etc/passwd)\n[来源](https://example.com/a)\n<script>test</script>'
  const result = await generateDocument('会议纪要', body, { format: 'docx', filename: '会议纪要.docx' }, new AbortController().signal)
  expect(result.metadata).toMatchObject({ filename: '会议纪要.docx', format: 'docx', sha256: fileHash(result.bytes), byteLength: result.bytes.length })
  const zip = await JSZip.loadAsync(result.bytes)
  const xml = await zip.file('word/document.xml').async('string')
  expect(xml).toContain('<w:tbl>'); expect(xml).toContain('会议纪要'); expect(xml).toContain('负责人'); expect(xml).toContain('[S1 00:12]')
  expect(xml).toContain('w:pStyle w:val="Title"'); expect(xml).toContain('未加载外部资源')
  expect(xml).toContain('<w:br/>')
  expect(xml).toContain('&lt;script&gt;test&lt;/script&gt;')
  expect(await zip.file('word/_rels/document.xml.rels').async('string')).not.toContain('file:///etc/passwd')
  expect(Object.keys(zip.files).some(name => /vbaProject|embeddings|media\//.test(name))).toBe(false)
})

it('rejects paths, non-Word filenames, excessive structure and interrupted generation without returning TXT', async () => {
  for (const filename of ['../secret.docx','/tmp/a.docx','x.txt','report.docm','a\\b.docx'])
    await expect(generateDocument('报告','正文',{format:'docx',filename},new AbortController().signal)).rejects.toThrow()
  await expect(generateDocument('报告','x'.repeat(40001),{format:'docx'},new AbortController().signal)).rejects.toThrow('40000')
  const controller=new AbortController()
  const pending=generateDocument('报告','正文',{format:'docx'},controller.signal); controller.abort()
  await expect(pending).rejects.toThrow('中断')
  const columns = Array.from({length:11},(_,i)=>`c${i}`).join('|')
  await expect(generateDocument('报告',`|${columns}|\n|${'---|'.repeat(11)}\n|${columns}|`,{format:'docx'},new AbortController().signal)).rejects.toThrow('未生成替代 TXT')
})
