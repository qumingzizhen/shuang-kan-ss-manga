import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 回归测试：快速滚动跳顶修复依赖滚动栈槽位高度稳定。
 * 占位符与未加载图片槽必须声明相同的最小高度，否则批次到达时
 * 滚动高度塌缩会让浏览器把阅读位置钳制回顶部。
 */
const cssPath = resolve(__dirname, "../../app/globals.css");
const css = readFileSync(cssPath, "utf8");

function minHeightFor(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`);
  const match = css.match(rule);
  if (!match) {
    return null;
  }
  const declaration = match[1].match(/min-height:\s*([^;]+);/);
  return declaration ? declaration[1].trim() : null;
}

describe("reader scroll slot height stability", () => {
  it("未加载图片槽与占位符声明相同的最小高度", () => {
    const placeholderHeight = minHeightFor(".reader-scroll-placeholder");
    const frameHeight = minHeightFor(".reader-scroll-page .reader-image-frame");

    expect(placeholderHeight).not.toBeNull();
    expect(frameHeight).not.toBeNull();
    expect(frameHeight).toBe(placeholderHeight);
  });

  it("scroll stack stays wide enough for desktop readers", () => {
    const stackRule = css.match(/\.reader-scroll-stack\s*\{([^}]*)\}/);
    const maxWidth = stackRule?.[1].match(/max-width:\s*([^;]+);/)?.[1].trim();

    expect(maxWidth).not.toBeNull();
    expect(Number.parseFloat(maxWidth ?? "0")).toBeGreaterThanOrEqual(1500);
  });

  it("scroll-mode top bar is hidden until the hover zone is used", () => {
    expect(css).toContain(".reader-header-hover-zone");
    expect(css).toMatch(/\.reader-header-hover-zone:hover\s*~\s*\.reader-header/);
    expect(css).toMatch(/\.reader-shell\.scroll-mode \.reader-header\s*\{[^}]*opacity:\s*0/);
  });

  it("scroll-mode images reserve an aspect ratio before loading", () => {
    const rule = css.match(/\.reader-scroll-page-button \.reader-image\.fit-width\s*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/aspect-ratio:\s*[^;]+;/);
  });
});