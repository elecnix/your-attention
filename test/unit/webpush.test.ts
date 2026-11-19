import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { b64urlDecode, b64urlEncode, decryptPayload, encryptPayload, generateVapid, sendPush, vapidAuthorization } from '../../src/core/webpush.ts';

const SUBJECT = 'https://example.invalid/contact';

describe('Web Push encryption, RFC 8291', () => {
  // Appendix A of the RFC: one message, with every input fixed.
  const vector = {
    plaintext: 'When I grow up, I want to be a watermelon',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  };

  it('produces the RFC test vector byte for byte', async () => {
    const body = await encryptPayload(new TextEncoder().encode(vector.plaintext), { p256dh: vector.uaPublic, auth: vector.auth }, {
      salt: b64urlDecode(vector.salt),
      ephemeral: { publicKey: vector.asPublic, privateKey: vector.asPrivate },
    });
    assert.equal(b64urlEncode(body), vector.body);
  });

  it('decrypts the RFC test vector with the subscriber keys', async () => {
    const plain = await decryptPayload(b64urlDecode(vector.body), { publicKey: vector.uaPublic, privateKey: vector.uaPrivate, auth: vector.auth });
    assert.equal(new TextDecoder().decode(plain), vector.plaintext);
  });

  it('uses a fresh salt and key for each message, and the subscriber reads each one', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const publicKey = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const auth = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const text = new TextEncoder().encode('{"id":"a","title":"Deploy now? ✋"}');
    const one = await encryptPayload(text, { p256dh: publicKey, auth });
    const two = await encryptPayload(text, { p256dh: publicKey, auth });
    assert.notDeepEqual(one, two);
    for (const body of [one, two]) {
      assert.deepEqual(await decryptPayload(body, { publicKey, privateKey: jwk.d ?? '', auth }), text);
    }
  });

  it('refuses a subscription key that is not a P-256 point', async () => {
    await assert.rejects(encryptPayload(new Uint8Array(3), { p256dh: b64urlEncode(new Uint8Array(65)), auth: vector.auth }));
    await assert.rejects(encryptPayload(new Uint8Array(3), { p256dh: vector.uaPublic, auth: 'AA' }), /auth/);
  });

  it('refuses a payload that does not fit one record', async () => {
    await assert.rejects(encryptPayload(new Uint8Array(4100), { p256dh: vector.uaPublic, auth: vector.auth }), /too large/);
  });
});

describe('VAPID, RFC 8292', () => {
  it('signs an ES256 token for the endpoint origin that its public key verifies', async () => {
    const vapid = await generateVapid();
    const header = await vapidAuthorization(vapid, 'https://push.example.invalid/send/abc123', SUBJECT, 1_700_000_000_000);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    assert.ok(m, `shape: ${header}`);
    const [, h, c, s, k] = m;
    assert.equal(k, vapid.publicKey);
    assert.equal(b64urlDecode(k ?? '').length, 65);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(h ?? ''))), { typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c ?? ''))) as { aud: string; exp: number; sub: string };
    assert.equal(claims.aud, 'https://push.example.invalid');
    assert.equal(claims.sub, SUBJECT);
    // The token ends within 24 hours, as the RFC requires, and lives long enough to cross a slow network.
    assert.ok(claims.exp > 1_700_000_000 + 3600 && claims.exp <= 1_700_000_000 + 24 * 3600);
    const sig = b64urlDecode(s ?? '');
    assert.equal(sig.length, 64, 'raw r and s, as JWS wants');
    const key = await crypto.subtle.importKey('raw', b64urlDecode(vapid.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, new TextEncoder().encode(`${h}.${c}`)));
    // A token for another message body, or signed by another key, does not verify.
    assert.ok(!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, new TextEncoder().encode(`${h}.x`))));
  });

  it('makes a new key pair each time, and keeps the private half out of the public key', async () => {
    const a = await generateVapid();
    const b = await generateVapid();
    assert.notEqual(a.publicKey, b.publicKey);
    assert.ok(!a.publicKey.includes(String(a.privateKey.d)));
  });
});

describe('sending a push', () => {
  async function subscriber() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    return {
      endpoint: 'https://push.example.invalid/send/xyz',
      p256dh: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
      auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
      privateKey: jwk.d ?? '',
    };
  }

  it('posts the encrypted payload with the VAPID header, a TTL and the aes128gcm encoding', async () => {
    const vapid = await generateVapid();
    const sub = await subscriber();
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
    const result = await sendPush(fetcher, vapid, sub, new TextEncoder().encode('{"id":"c1","title":"Hi"}'), { subject: SUBJECT });
    assert.deepEqual(result, { ok: true, status: 201, attempts: 1 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, sub.endpoint);
    const headers = new Headers(seen[0]?.init.headers);
    assert.equal(headers.get('content-encoding'), 'aes128gcm');
    assert.ok(Number(headers.get('ttl')) > 0);
    assert.match(headers.get('authorization') ?? '', /^vapid t=.+, k=.+$/);
    const plain = await decryptPayload(new Uint8Array(seen[0]?.init.body as Uint8Array), { publicKey: sub.p256dh, privateKey: sub.privateKey, auth: sub.auth });
    assert.equal(new TextDecoder().decode(plain), '{"id":"c1","title":"Hi"}');
  });

  it('reports 404 and 410 as gone, and does not retry them', async () => {
    const vapid = await generateVapid();
    const sub = await subscriber();
    for (const status of [404, 410]) {
      let calls = 0;
      const fetcher = (async () => { calls++; return new Response(null, { status }); }) as unknown as typeof fetch;
      assert.deepEqual(await sendPush(fetcher, vapid, sub, new Uint8Array(2)), { ok: false, gone: true, status, attempts: 1 });
      assert.equal(calls, 1);
    }
  });

  it('retries a 500, a 429 and a network error a bounded number of times, then gives up', async () => {
    const vapid = await generateVapid();
    const sub = await subscriber();
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    let calls = 0;
    const failing = (async () => { calls++; return new Response(null, { status: 503 }); }) as unknown as typeof fetch;
    const r = await sendPush(failing, vapid, sub, new Uint8Array(2), { wait });
    assert.equal(r.ok, false);
    assert.equal(calls, 3);
    assert.equal(r.attempts, 3);
    assert.equal(waits.length, 2);

    calls = 0;
    const flaky = (async () => { calls++; if (calls === 1) throw new TypeError('network down'); if (calls === 2) return new Response(null, { status: 429 }); return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
    assert.deepEqual(await sendPush(flaky, vapid, sub, new Uint8Array(2), { wait }), { ok: true, status: 201, attempts: 3 });
  });

  it('does not retry a refusal that a retry cannot fix', async () => {
    const vapid = await generateVapid();
    const sub = await subscriber();
    for (const status of [400, 401, 403, 413]) {
      let calls = 0;
      const fetcher = (async () => { calls++; return new Response(null, { status }); }) as unknown as typeof fetch;
      const r = await sendPush(fetcher, vapid, sub, new Uint8Array(2));
      assert.equal(r.ok, false);
      assert.equal(calls, 1, `status ${status}`);
    }
  });
});
