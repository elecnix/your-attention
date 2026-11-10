// A page whose socket is refused and whose event stream is closed must keep trying the socket instead of resting on
// the stream. The hosted build refuses GET /v1/events with 410 by design, so a page that settles there shows
// "unreachable" while every plain request answers.
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => { inbox = await startInbox(); });
test.afterAll(async () => { await inbox.close(); });

test('keeps trying the socket when the stream answers 410', async ({ page }) => {
  let sockets = 0;
  let streams = 0;
  // The probe says this inbox serves a page socket, which is what the real one answers.
  await page.route('**/v1/ws', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"webSocket":true}' }));
  // Every upgrade is refused, as a full inbox answered before the socket budget kept a slot for the page.
  await page.routeWebSocket('**/v1/ws?page=1**', (ws) => { sockets++; ws.close({ code: 1013, reason: 'refused' }); });
  // And the hosted build answers the stream with 410.
  await page.route('**/v1/events**', (route) => { streams++; return route.fulfill({ status: 410, contentType: 'application/json', body: '{"error":"ws only"}' }); });

  // The page cannot reach "connected" in this test, so it is opened directly rather than through inbox.open().
  await page.goto(`${inbox.server.url}/#token=${inbox.server.ownerToken}`);
  await page.locator('.bar .pill.status-pill').waitFor();
  // The state answers, so the page is not unreachable: it is reconnecting, and it keeps asking for a socket.
  await expect(page.locator('.bar .pill.status-pill')).toContainText('reconnecting');
  await expect.poll(() => sockets, { timeout: 15000 }).toBeGreaterThan(2);
  // The stream was tried once and abandoned, rather than becoming the page's resting place.
  expect(streams).toBeLessThanOrEqual(1);
});
