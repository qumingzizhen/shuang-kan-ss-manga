import { AlertTriangle, RefreshCcw } from "lucide-react";
import type { ReactNode } from "react";
import clsx from "clsx";

export type AsyncStateKind = "loading" | "empty" | "error";

type AsyncStateProps = {
  kind: AsyncStateKind;
  message: string;
  compact?: boolean;
  className?: string;
  icon?: ReactNode;
};

export function AsyncState({
  kind,
  message,
  compact = false,
  className,
  icon,
}: AsyncStateProps) {
  const defaultIcon =
    kind === "error" ? <AlertTriangle size={16} aria-hidden /> :
    kind === "loading" ? <RefreshCcw size={20} aria-hidden /> :
    null;

  return (
    <div
      className={clsx(kind === "error" ? "error" : "empty", compact && kind !== "error" && "compact", "async-state", kind, className)}
      role={kind === "error" ? "alert" : "status"}
      aria-live={kind === "error" ? "assertive" : "polite"}
    >
      {icon ?? defaultIcon}
      <span>{message}</span>
    </div>
  );
}