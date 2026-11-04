import { describe, it, expect } from 'vitest';
import { decryptFeishuEncrypt, encryptFeishuPayload } from '../feishuCrypto.js';
import { normalizeFeishuBody } from '../feishuNormalize.js';
import { replyOrCreateFeishuMessage } from '../feishuOutbound.js';

describe('feishuCrypto', () => {
  it('roundtrips AES encrypt/decrypt', () => {
    const key = 'test_encrypt_key_loom_r7'; // gitleaks:allow -- deterministic test fixture, not a service credential
    const plain = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const enc = encryptFeishuPayload(plain, key);
    const out = decryptFeishuEncrypt(enc, key);
    expect(JSON.parse(out).challenge).toBe('abc123');
  });
});

describe('feishuNormalize schema 2.0', () => {
  it('parses im.message.receive_v1 content JSON text', () => {
    const body = {
      schema: '2.0',
      header: {
        event_id: 'evt_1',
        event_type: 'im.message.receive_v1',
        token: 't',
        app_id: 'cli_x',
      },
      event: {
        sender: {
          sender_id: { open_id: 'ou_zhang' },
          sender_type: 'user',
        },
        message: {
          message_id: 'om_real_1',
          chat_id: 'oc_ops',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 报障：divide(10,0) Infinity' }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Loom' }],
        },
      },
    };
    const n = normalizeFeishuBody(body, { appId: 'cli_x' });
    expect(n).not.toBeNull();
    expect(n!.sourceKind).toBe('feishu.message');
    expect(n!.payload.text).toContain('divide(10,0)');
    expect(n!.payload.message_id).toBe('om_real_1');
    expect(n!.payload.chat_id).toBe('oc_ops');
    expect(n!.payload.sender).toMatchObject({ open_id: 'ou_zhang' });
  });
});

describe('feishuOutbound graceful fallback', () => {
  it('returns sim skip without credentials', async () => {
    const r = await replyOrCreateFeishuMessage({
      creds: { appId: '', appSecret: '' },
      text: 'hi',
      messageId: 'om_x',
    });
    expect(r.skipped).toBe(true);
    expect(r.delivery).toBe('sim');
  });

  it('marks feishu_failed when token endpoint errors', async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error('network down');
    };
    const r = await replyOrCreateFeishuMessage({
      creds: { appId: 'cli_x', appSecret: 'sec' },
      text: 'hi',
      messageId: 'om_x',
      fetchImpl: fakeFetch,
    });
    expect(r.ok).toBe(false);
    expect(r.delivery).toBe('feishu_failed');
  });
});
