import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.use({ baseURL: `http://localhost:${process.env.E2E_PORT_01_MINIMAL}` });

async function waitForHydration(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(
    () =>
      Object.getOwnPropertyNames(document.body).some((k) =>
        k.startsWith('__reactFiber'),
      ),
    null,
    { timeout: 60_000 },
  );
}

test('server render cache + opt-in etag skip + invalidation', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  await waitForHydration(page);
  await expect(page.getByTestId('home-heading')).toBeVisible();

  const firstRsc = page.waitForResponse('**/RSC/R/cached.txt**');
  await page.getByTestId('to-cached').click();
  const firstBody = await (await firstRsc).text();
  const content = page.getByTestId('cached-content');
  await expect(content).toHaveText(/cached render #\d+/);
  const firstContent = await content.textContent();
  const firstCount = Number(firstContent!.match(/#(\d+)$/)![1]);
  const firstNested = await page.getByTestId('nested-content').textContent();
  const firstNestedCount = Number(firstNested!.match(/#(\d+)$/)![1]);
  expect(firstBody).toContain('cached-content');
  await expect(page.getByTestId('counter')).toHaveText('Count: 0');
  await page.getByTestId('counter').click();
  await expect(page.getByTestId('counter')).toHaveText('Count: 1');

  const freshContext = await browser.newContext();
  try {
    const freshPage = await freshContext.newPage();
    await freshPage.goto('/cached');
    await waitForHydration(freshPage);
    await expect(freshPage.getByTestId('cached-content')).toHaveText(
      firstContent!,
    );
    await expect(freshPage.getByTestId('nested-content')).toHaveText(
      firstNested!,
    );
    await expect(freshPage.getByTestId('counter')).toHaveText('Count: 0');
    await freshPage.getByTestId('counter').click();
    await expect(freshPage.getByTestId('counter')).toHaveText('Count: 1');
  } finally {
    await freshContext.close();
  }

  await page.getByTestId('to-home').click();
  await expect(page.getByTestId('home-heading')).toBeVisible();
  const secondRsc = page.waitForResponse('**/RSC/R/cached.txt**');
  await page.getByTestId('to-cached').click();
  const secondBody = await (await secondRsc).text();
  await expect(content).toHaveText(firstContent!);
  await expect(page.getByTestId('nested-content')).toHaveText(firstNested!);
  expect(secondBody).not.toContain('cached-content');

  await page.getByTestId('to-home').click();
  await expect(page.getByTestId('home-heading')).toBeVisible();
  const invalidation = await page.request.post('/invalidate');
  expect(invalidation.ok()).toBe(true);
  const thirdRsc = page.waitForResponse('**/RSC/R/cached.txt**');
  await page.getByTestId('to-cached').click();
  const thirdBody = await (await thirdRsc).text();
  await expect(content).toHaveText(`cached render #${firstCount + 1}`);
  await expect(page.getByTestId('nested-content')).toHaveText(
    `nested render #${firstNestedCount + 1}`,
  );
  expect(thirdBody).toContain('cached-content');
});

test('the etag tracks TTL: skipped while fresh, re-sent after expiry', async ({
  page,
}) => {
  await page.goto('/');
  await waitForHydration(page);
  await expect(page.getByTestId('home-heading')).toBeVisible();

  const firstRsc = page.waitForResponse('**/RSC/R/cached-ttl.txt**');
  await page.getByTestId('to-cached-ttl').click();
  const firstBody = await (await firstRsc).text();
  const content = page.getByTestId('cached-ttl-content');
  await expect(content).toHaveText(/cached-ttl render #\d+/);
  const firstContent = await content.textContent();
  const firstCount = Number(firstContent!.match(/#(\d+)$/)![1]);
  expect(firstBody).toContain('cached-ttl-content');

  await page.getByTestId('ttl-to-home').click();
  await expect(page.getByTestId('home-heading')).toBeVisible();
  const freshRsc = page.waitForResponse('**/RSC/R/cached-ttl.txt**');
  await page.getByTestId('to-cached-ttl').click();
  const freshBody = await (await freshRsc).text();
  await expect(content).toHaveText(firstContent!);
  expect(freshBody).not.toContain('cached-ttl-content');

  await expect
    .poll(
      async () => {
        await page.getByTestId('ttl-to-home').click();
        await expect(page.getByTestId('home-heading')).toBeVisible();
        const expiredRsc = page.waitForResponse('**/RSC/R/cached-ttl.txt**');
        await page.getByTestId('to-cached-ttl').click();
        const expiredBody = await (await expiredRsc).text();
        return {
          content: await content.textContent(),
          sent: expiredBody.includes('cached-ttl-content'),
        };
      },
      { timeout: 15_000, intervals: [250, 500, 1000] },
    )
    .toEqual({ content: `cached-ttl render #${firstCount + 1}`, sent: true });
});

test('cache.fn replays Flight values and caches undefined results', async ({
  request,
}) => {
  const firstResponse = await request.get('/values');
  expect(firstResponse.ok()).toBe(true);
  const first = await firstResponse.json();
  expect(first).toEqual({
    generation: expect.any(Number),
    date: '2026-01-01T00:00:00.000Z',
    map: [['answer', 42]],
    set: ['a', 'b'],
    bigint: '123',
    bytes: [0, 255],
    empty: null,
    missing: true,
    missingCalls: 1,
  });

  const secondResponse = await request.get('/values');
  expect(secondResponse.ok()).toBe(true);
  expect(await secondResponse.json()).toEqual(first);
});

test('a failed RSC render can be retried without caching the error', async ({
  request,
}) => {
  const firstResponse = await request.get('/retry');
  expect(firstResponse.status()).toBe(503);

  const secondResponse = await request.get('/retry');
  expect(secondResponse.ok()).toBe(true);
  const recovered = await secondResponse.json();
  expect(recovered).toEqual({
    content: 'ready',
    etag: expect.any(String),
    calls: 2,
  });

  const thirdResponse = await request.get('/retry');
  expect(thirdResponse.ok()).toBe(true);
  expect(await thirdResponse.json()).toEqual(recovered);
});

test('a nested RSC render failure is retried without caching the error', async ({
  request,
}) => {
  const firstResponse = await request.get('/retry?nested');
  expect(firstResponse.status()).toBe(503);

  const secondResponse = await request.get('/retry?nested');
  expect(secondResponse.ok()).toBe(true);
  const recovered = await secondResponse.json();
  expect(recovered).toEqual({ etag: expect.any(String), calls: 2 });

  const thirdResponse = await request.get('/retry?nested');
  expect(thirdResponse.ok()).toBe(true);
  expect(await thirdResponse.json()).toEqual(recovered);
});
