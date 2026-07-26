import { expect, test } from "@playwright/test";

test("搜索结果使用封面网格、按最新上传排列，并把操作与 Tag 放在二级详情", async ({ page }) => {
  await page.route("**/v1/sources", (route) => route.fulfill({
    json: [{
      id: "e-hentai",
      name: "E-Hentai",
      version: "1.0.0",
      capabilities: ["search", "gallery", "download", "online_read"],
      enabled: true,
    }],
  }));
  await page.route("**/v1/tasks", (route) => route.fulfill({
    json: [{
      id: "ui-search-task",
      kind: "search",
      status: "completed",
      title: "排序界面测试",
      payload: { source_ids: ["e-hentai"], tags: [] },
      progress: { total: 2, done: 2, failed: 0, message: "completed" },
      output: {
        type: "search_results",
        has_more: false,
        results: [
          {
            source_id: "e-hentai",
            gallery_url: "https://e-hentai.org/g/1/old/",
            title: "较早作品",
            tags: ["language:chinese"],
            uploader: "older-user",
            uploaded_at: "2026-07-24T10:00:00Z",
            category: "Manga",
          },
          {
            source_id: "e-hentai",
            gallery_url: "https://e-hentai.org/g/2/new/",
            title: "最新作品",
            tags: [],
            uploader: "new-user",
            uploaded_at: "2026-07-26T10:00:00Z",
            category: "Doujinshi",
          },
        ],
      },
      created_at: "2026-07-26T10:00:00Z",
      updated_at: "2026-07-26T10:00:00Z",
    }],
  }));
  await page.route("**/v1/search-result-details", async (route) => {
    await route.fulfill({
      json: {
        ...route.request().postDataJSON(),
        tags: ["language:chinese", "female:big breasts"],
        page_count: 42,
      },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /排序界面测试/ }).click();
  const titles = page.locator(".search-result-summary strong");
  await expect(titles.nth(0)).toHaveText("最新作品");
  await expect(titles.nth(1)).toHaveText("较早作品");
  await expect(page.getByRole("button", { name: "在线阅读", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下载", exact: true })).toHaveCount(0);
  const cards = page.locator(".search-result-card");
  await expect(cards).toHaveCount(2);
  const firstCard = await cards.nth(0).boundingBox();
  const secondCard = await cards.nth(1).boundingBox();
  expect(firstCard).not.toBeNull();
  expect(secondCard).not.toBeNull();
  expect(Math.abs((firstCard?.y ?? 0) - (secondCard?.y ?? 0))).toBeLessThan(4);
  expect(secondCard?.x ?? 0).toBeGreaterThan(firstCard?.x ?? 0);

  await page.getByRole("button", { name: "查看详情：最新作品" }).click();
  await expect(page.getByRole("dialog", { name: "最新作品" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "最新作品" }).getByText("female:big breasts", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "在线阅读", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "下载", exact: true })).toBeVisible();
});
