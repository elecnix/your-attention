// A nested list in a card's text draws as a list inside its item, indented, with a bullet per level, in both color schemes.
import { expect, test } from '@playwright/test';
import { startInbox, type TestInbox } from './inbox.ts';

let inbox: TestInbox;
test.beforeAll(async () => {
  inbox = await startInbox();
  await inbox.agent.post({ id: 'nested', agent: 's-nested', title: 'Merge the release', priority: 'now', text: [
    'Before I merge, three checks remain:',
    '',
    '- Release checklist:',
    '  - the changelog names the fix',
    '  - CI is green on main',
    '    - unit and browser jobs',
    '  - the tag matches package.json',
    '- Steps after the merge:',
    '  3. tag the commit',
    '  4. watch the release run',
    '- Then I post the merge card.',
  ].join('\n') });
});
test.afterAll(async () => { await inbox.close(); });

for (const scheme of ['dark', 'light'] as const) {
  test(`a nested list draws inside its item in the ${scheme} scheme`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 900, height: 700 });
    await inbox.open(page);
    await page.locator('.q', { hasText: 'Merge the release' }).click();
    const text = page.locator('.focus-card .card-text');
    const top = text.locator(':scope > ul');
    await expect(top).toHaveCount(1);
    await expect(top.locator(':scope > li')).toHaveCount(3);
    const second = top.locator(':scope > li > ul');
    await expect(second.locator(':scope > li')).toHaveCount(3);
    await expect(second.locator(':scope > li > ul > li')).toHaveText('unit and browser jobs');
    await expect(top.locator(':scope > li > ol')).toHaveAttribute('start', '3');
    const style = (sel: string) => text.locator(sel).first().evaluate((el) => getComputedStyle(el).listStyleType);
    expect(await style(':scope > ul')).toBe('disc');
    expect(await style(':scope > ul > li > ul')).toBe('circle');
    expect(await style(':scope > ul > li > ul > li > ul')).toBe('square');
    expect(await style(':scope > ul > li > ol')).toBe('decimal');
    // Each level starts to the right of its parent's text.
    const left = (sel: string) => text.locator(sel).first().evaluate((el) => el.getBoundingClientRect().left);
    expect(await left(':scope > ul > li > ul > li')).toBeGreaterThan(await left(':scope > ul > li'));
    expect(await left(':scope > ul > li > ul > li > ul > li')).toBeGreaterThan(await left(':scope > ul > li > ul > li'));
    // A nested list keeps its items as tight as its parent's: no gap after it before the parent's next item.
    const gap = await text.locator(':scope > ul > li').first().evaluate((li) => li.nextElementSibling!.getBoundingClientRect().top - li.getBoundingClientRect().bottom);
    expect(gap).toBeLessThan(2);
    await text.screenshot({ path: info.outputPath(`nested-lists-${scheme}.png`) });
  });
}
