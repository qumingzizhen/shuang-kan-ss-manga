import { expect, test } from "@playwright/test";

test("任务控制台入口和规划功能状态清晰", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "任务控制台", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByRole("button", { name: /审核/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /基础设施/ })).toBeDisabled();
  await expect(page.getByText("规划中")).toHaveCount(2);
});

test("主工作区在当前视口没有水平溢出", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "任务控制台", level: 1 })).toBeVisible();
  const layout = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));

  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
});

test("任务与文件库视图可以往返切换", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "文件库", exact: true }).click();
  await expect(page.getByRole("heading", { name: "文件库", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "文件库统计" })).toBeVisible();

  await page.getByRole("button", { name: "任务控制台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "任务控制台", level: 1 })).toBeVisible();
});

test("实时通道不可用时自动降级为轮询且不误报离线", async ({ page }) => {
  await page.route("**/v1/tasks/events", (route) =>
    route.fulfill({
      status: 503,
      contentType: "text/plain",
      body: "event stream unavailable",
    }),
  );

  await page.goto("/");

  const connectionStatus = page.getByTestId("connection-status");
  await expect(connectionStatus).toHaveText("在线 · 轮询");
  await expect(connectionStatus).toHaveAttribute("title", /每 4 秒自动更新/);
  await expect(connectionStatus).not.toHaveText("离线");
});
