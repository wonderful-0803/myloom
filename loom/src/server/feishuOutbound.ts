/**
 * Feishu outbound IM: tenant_access_token + reply / create message.
 * Graceful: no credentials / network failure → caller keeps local ACK bubble.
 */
export interface FeishuCreds {
  appId: string;
  appSecret: string;
}

export interface OutboundResult {
  ok: boolean;
  delivery: 'feishu' | 'feishu_failed' | 'sim';
  error?: string;
  messageId?: string;
  skipped?: boolean;
}

const FEISHU_HOST = process.env.FEISHU_API_HOST || 'https://open.feishu.cn';

let cachedToken: { token: string; expireAt: number } | null = null;

export function clearTokenCache() {
  cachedToken = null;
}

export async function getTenantAccessToken(
  creds: FeishuCreds,
  fetchImpl: typeof fetch = fetch
): Promise<{ token: string; expire: number } | { error: string }> {
  if (!creds.appId || !creds.appSecret) {
    return { error: 'missing app_id / app_secret' };
  }
  if (cachedToken && cachedToken.expireAt > Date.now() + 60_000) {
    return { token: cachedToken.token, expire: cachedToken.expireAt };
  }
  try {
    const res = await fetchImpl(`${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== 0 || !data.tenant_access_token) {
      return { error: data.msg || `token http ${res.status}` };
    }
    const expireAt = Date.now() + (Number(data.expire) || 7200) * 1000;
    cachedToken = { token: data.tenant_access_token, expireAt };
    return { token: data.tenant_access_token, expire: expireAt };
  } catch (e: any) {
    return { error: String(e?.message || e) };
  }
}

export async function replyOrCreateFeishuMessage(opts: {
  creds: FeishuCreds;
  text: string;
  messageId?: string | null;
  chatId?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<OutboundResult> {
  const { creds, text, messageId, chatId } = opts;
  const fetchImpl = opts.fetchImpl || fetch;

  if (!creds.appId || !creds.appSecret) {
    return { ok: false, delivery: 'sim', skipped: true, error: 'no credentials' };
  }
  if (!messageId && !chatId) {
    return { ok: false, delivery: 'sim', skipped: true, error: 'no message_id / chat_id' };
  }

  const tok = await getTenantAccessToken(creds, fetchImpl);
  if ('error' in tok) {
    return { ok: false, delivery: 'feishu_failed', error: tok.error };
  }

  const content = JSON.stringify({ text });
  try {
    if (messageId) {
      const res = await fetchImpl(
        `${FEISHU_HOST}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tok.token}`,
          },
          body: JSON.stringify({ content, msg_type: 'text' }),
        }
      );
      const data: any = await res.json().catch(() => ({}));
      if (res.ok && data.code === 0) {
        return {
          ok: true,
          delivery: 'feishu',
          messageId: data.data?.message_id,
        };
      }
      // fall through to create if reply fails (e.g. sim ids)
      if (!chatId) {
        return {
          ok: false,
          delivery: 'feishu_failed',
          error: data.msg || `reply http ${res.status}`,
        };
      }
    }

    if (chatId) {
      const res = await fetchImpl(
        `${FEISHU_HOST}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tok.token}`,
          },
          body: JSON.stringify({
            receive_id: chatId,
            msg_type: 'text',
            content,
          }),
        }
      );
      const data: any = await res.json().catch(() => ({}));
      if (res.ok && data.code === 0) {
        return {
          ok: true,
          delivery: 'feishu',
          messageId: data.data?.message_id,
        };
      }
      return {
        ok: false,
        delivery: 'feishu_failed',
        error: data.msg || `create http ${res.status}`,
      };
    }
  } catch (e: any) {
    return { ok: false, delivery: 'feishu_failed', error: String(e?.message || e) };
  }

  return { ok: false, delivery: 'sim', skipped: true, error: 'unreachable' };
}
