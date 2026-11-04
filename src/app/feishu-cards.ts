/** Card 2.0 rendering and the minimal native callback envelope; authority stays in server-side grants. */
import { z } from 'zod'

export interface CardGrant {
  token: string; owner: string; chatId: string; triggerId: string; messageId?: string
  action: string; args: string[]; ticketId?: string; subject?: string; controlRevision?: number; artifactVersion?: number
  expiresAt: number; usedBy?: string
}
export const CardEventSchema = z.looseObject({
  type: z.literal('card.action.trigger'), event_id: z.string().min(1).max(200),
  operator_id: z.string().regex(/^ou_[a-zA-Z0-9]+$/), chat_id: z.string().regex(/^oc_[a-zA-Z0-9]+$/),
  message_id: z.string().regex(/^om_[a-zA-Z0-9]+$/), timestamp: z.string().regex(/^\d{10,16}$/),
  host: z.literal('im_message'), action_tag: z.literal('button'), action_value: z.string().max(2000).optional(),
  action_name: z.string().max(100).optional(), form_value: z.string().max(8000).optional(),
})
export type CardEvent = z.infer<typeof CardEventSchema>
type Element = Record<string, unknown>
export interface CardAction { label: string; token: string; primary?: boolean }
export const cardText = (value: string): string => value.replace(/[&<>*~\[\]()#`_]/g, char => `&#${char.charCodeAt(0)};`)
const markdown = (text: string): Element => ({ tag: 'markdown', content: cardText(text) })
const columns = (elements: Element[]): Element => ({ tag: 'column_set', flex_mode: 'flow', horizontal_spacing: 'medium',
  columns: elements.map(element => ({ tag: 'column', width: 'weighted', weight: 1, elements: [element] })) })
const button = ({ label, token, primary }: CardAction): Element => ({ tag: 'button', text: { tag: 'plain_text', content: label },
  type: primary ? 'primary_filled' : 'default', behaviors: [{ type: 'callback', value: { grant: token } }] })
/** Compact state/detail/action blocks; quoted user text is escaped so it cannot mention users or inject card markup. */
export function assistantCard(title: string, text: string, actions: CardAction[] = [], editor?: { token: string; body: string }): Record<string, unknown> {
  const elements: Element[] = [{ tag: 'column_set', flex_mode: 'stretch', columns: [{ tag: 'column', width: 'weighted', weight: 1,
    padding: '12px', elements: [markdown(text.slice(0, 6000))] }] }]
  if (editor) elements.push({ tag: 'form', name: 'artifact_edit', elements: [
    { tag: 'input', name: 'body', input_type: 'multiline_text', default_value: editor.body, rows: 8,
      max_length: 1000, required: true, width: 'fill', label: { tag: 'plain_text', content: '新版正文（保存后保留旧版）' } },
    { tag: 'button', name: `save_${editor.token}`, form_action_type: 'submit', type: 'primary_filled', text: { tag: 'plain_text', content: '保存新版本' } },
  ] })
  if (actions.length) elements.push(columns(actions.map(button)))
  return { schema: '2.0', config: { width_mode: 'default', enable_forward: false },
    header: { template: 'blue', title: { tag: 'plain_text', content: title.slice(0, 60) } },
    body: { direction: 'vertical', vertical_spacing: 'large', elements } }
}
/** A list uses one visual row per task and one primary selection, with no raw task IDs to copy. */
export function taskListCard(rows: { title: string; detail: string; action: CardAction }[], next?: CardAction): Record<string, unknown> {
  return { schema: '2.0', config: { width_mode: 'default', enable_forward: false },
    header: { template: 'blue', title: { tag: 'plain_text', content: '我的任务' } },
    body: { direction: 'vertical', vertical_spacing: 'large', elements: [
      ...rows.map(row => ({ tag: 'column_set', flex_mode: 'stretch', columns: [
        { tag: 'column', width: 'weighted', weight: 4, elements: [markdown(`${row.title}\n${row.detail}`)] },
        { tag: 'column', width: 'weighted', weight: 1, elements: [button(row.action)] },
      ] })), ...next ? [columns([button(next)])] : [],
    ] } }
}
