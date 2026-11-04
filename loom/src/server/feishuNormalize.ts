/**
 * Normalize Feishu Open Platform callbacks (schema 2.0 + sim v1) into Loom payloads.
 */
import type { SourceKind } from '../shared/types.js';

export interface NormalizedFeishuEvent {
  sourceKind: SourceKind;
  type: string;
  payload: Record<string, unknown>;
  threadTopics: string[];
  eventType: string;
  rawSchema?: string;
}

function parseMessageContent(content: unknown): string {
  if (typeof content !== 'string') return String(content || '');
  try {
    const j = JSON.parse(content);
    if (typeof j?.text === 'string') return j.text;
    if (typeof j?.content === 'string') return j.content;
    return content;
  } catch {
    return content;
  }
}

function mentionsBot(event: any, appId?: string): boolean {
  const mentions = event?.message?.mentions || event?.mentions || [];
  if (!Array.isArray(mentions) || mentions.length === 0) {
    // If text has @ and we can't tell — treat as mention when chat is p2p, else unknown → true for ops bot demos
    return event?.message?.chat_type === 'p2p' ? true : Boolean(event?.mentions_bot);
  }
  if (!appId) return mentions.length > 0;
  return mentions.some((m: any) => {
    const id = m?.id || {};
    return (
      id.open_id ||
      id.user_id ||
      m?.name ||
      true
    );
  });
}

/** Detect schema 2.0 Open Platform envelope */
export function isFeishuSchemaV2(body: any): boolean {
  return (
    body?.schema === '2.0' ||
    (body?.header?.event_type && body?.event)
  );
}

export function normalizeFeishuBody(
  body: any,
  opts?: { appId?: string }
): NormalizedFeishuEvent | null {
  if (!body || typeof body !== 'object') return null;

  // --- Real Open Platform schema 2.0 ---
  if (isFeishuSchemaV2(body)) {
    const eventType = String(body.header?.event_type || '');
    const event = body.event || {};

    if (eventType === 'im.message.receive_v1' || eventType.startsWith('im.message.')) {
      const message = event.message || {};
      const sender = event.sender || {};
      const senderId = sender.sender_id || {};
      const text = parseMessageContent(message.content);
      const chatId = String(message.chat_id || '');
      const messageId = String(message.message_id || '');
      const openId = String(senderId.open_id || '');
      const chatName = String(
        message.chat_name || (message.chat_type === 'p2p' ? '单聊' : `群 ${chatId.slice(0, 8) || '未知'}`)
      );

      return {
        sourceKind: 'feishu.message',
        type: 'feishu_im_message',
        eventType: eventType || 'im.message.receive_v1',
        rawSchema: '2.0',
        payload: {
          schema: '2.0',
          event_type: eventType || 'im.message.receive_v1',
          chat_id: chatId,
          chat_name: chatName,
          chat_type: message.chat_type || 'group',
          message_id: messageId,
          sender: {
            name: senderId.name || openId || '飞书用户',
            open_id: openId,
            user_id: senderId.user_id || '',
            union_id: senderId.union_id || '',
          },
          mentions_bot: mentionsBot(event, opts?.appId) || /@/.test(text),
          mentions: message.mentions || [],
          text,
          message_type: message.message_type || 'text',
          raw_content: message.content,
        },
        threadTopics: [`feishu#${chatName}`],
      };
    }

    if (eventType.includes('drive.file.comment') || eventType === 'drive.file.comment_add_v1') {
      const text = String(event.comment?.content || event.text || event.comment || '');
      const docTitle = String(event.file_token || event.doc_title || '云文档');
      return {
        sourceKind: 'feishu.doc_comment',
        type: 'feishu_doc_comment',
        eventType,
        rawSchema: '2.0',
        payload: {
          schema: '2.0',
          event_type: eventType,
          doc_token: event.file_token || event.doc_token || '',
          doc_title: docTitle,
          commenter: event.operator?.name || event.commenter || '评论者',
          text,
        },
        threadTopics: [`feishu-doc#${docTitle}`],
      };
    }

    if (eventType.includes('calendar') || eventType === 'calendar.event.reminder') {
      const summary = String(event.summary || event.event?.summary || '日历提醒');
      return {
        sourceKind: 'feishu.calendar',
        type: 'feishu_calendar_reminder',
        eventType,
        rawSchema: '2.0',
        payload: {
          schema: '2.0',
          event_type: eventType,
          summary,
          start_time: event.start_time || event.event?.start_time || new Date().toISOString(),
        },
        threadTopics: ['feishu-calendar#weekly'],
      };
    }

    if (eventType.includes('approval') || eventType === 'approval.instance') {
      return {
        sourceKind: 'feishu.approval',
        type: 'feishu_approval',
        eventType,
        rawSchema: '2.0',
        payload: {
          schema: '2.0',
          event_type: eventType,
          approval_name: event.approval_name || event.approval_code || '审批',
          status: event.status || event.instance_status || 'APPROVED',
          applicant: event.user_id || event.applicant || '',
        },
        threadTopics: ['feishu-approval#release'],
      };
    }

    // Unknown v2 event — still accept as message-like if event.message present
    if (event.message) {
      return normalizeFeishuBody(
        { ...body, header: { ...body.header, event_type: 'im.message.receive_v1' } },
        opts
      );
    }
    return null;
  }

  // --- Sim / legacy flat body handled by caller (scenario=...) ---
  return null;
}
