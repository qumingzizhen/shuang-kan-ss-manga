import type { ReactNode } from "react";
import type { ReaderPageUiStatus } from "@/lib/reader-scroll";

type ReaderScrollStackPage = {
  index: number;
  url: string;
};

type ReaderScrollStackProps<TPage extends ReaderScrollStackPage> = {
  pages: Map<number, TPage>;
  pageNumbers: number[];
  currentPage: number;
  disabled: boolean;
  getKey: (page: TPage) => string;
  getCaption: (page: TPage) => string;
  getStatus?: (page: TPage) => ReaderPageUiStatus;
  jumpToPage: (page: number) => void | Promise<void>;
  renderPage: (page: TPage, loading: "eager" | "lazy") => ReactNode;
};

/**
 * Continuous (scroll-mode) reader stack shared by the local library reader and
 * the remote online reader. Missing pages render as stable-height placeholders
 * so layout cannot collapse while the next batch is still loading.
 */
export function ReaderScrollStack<TPage extends ReaderScrollStackPage>(options: ReaderScrollStackProps<TPage>) {
  return (
    <div className="reader-scroll-stack" aria-label="连续阅读页">
      {options.pageNumbers.map((pageNumber) => {
        const page = options.pages.get(pageNumber);
        if (!page) {
          return (
            <div className="reader-scroll-placeholder" key={`placeholder-${pageNumber}`}>
              <strong>p{pageNumber}</strong>
              <span>等待预载</span>
            </div>
          );
        }

        const pageStatus = options.getStatus?.(page) ?? "unknown";
        return (
          <figure
            className={
              page.index === options.currentPage
                ? `reader-scroll-page active ${pageStatus}`
                : `reader-scroll-page ${pageStatus}`
            }
            data-reader-page={page.index}
            key={options.getKey(page)}
          >
            <div
              className="reader-scroll-page-button"
              role="button"
              tabIndex={options.disabled ? -1 : 0}
              aria-disabled={options.disabled}
              aria-current={page.index === options.currentPage ? "page" : undefined}
              onClick={() => {
                if (!options.disabled) {
                  void options.jumpToPage(page.index);
                }
              }}
              onKeyDown={(event) => {
                if (options.disabled || (event.key !== "Enter" && event.key !== " ")) {
                  return;
                }
                event.preventDefault();
                void options.jumpToPage(page.index);
              }}
            >
              <span className="reader-scroll-page-index">p{page.index}</span>
              {options.renderPage(page, page.index === options.currentPage ? "eager" : "lazy")}
            </div>
            <figcaption>{options.getCaption(page)}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}