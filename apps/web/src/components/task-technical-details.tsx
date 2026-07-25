"use client";

import { ChevronDown, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { prettyJson } from "@/lib/json";

type TaskTechnicalDetailsProps = {
  payload: unknown;
  output: unknown;
  onCopy: (label: string, value: string) => void;
};


export function TaskTechnicalDetails({ payload, output, onCopy }: TaskTechnicalDetailsProps) {
  const [expanded, setExpanded] = useState(false);
  // Large task outputs are serialized only when an operator explicitly opens diagnostics.
  const payloadText = useMemo(() => (expanded ? prettyJson(payload) : ""), [expanded, payload]);
  const outputText = useMemo(() => (expanded ? prettyJson(output) : ""), [expanded, output]);

  return (
    <details className="technical-details" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span>
          <strong>技术详情</strong>
          <small>仅在故障排查时展开原始输入与输出</small>
        </span>
        <ChevronDown size={16} aria-hidden />
      </summary>
      {expanded ? (
        <div className="technical-details-body">
          <section className="detail-section">
            <div className="detail-section-title">
              <h3>输入参数</h3>
              <button className="mini-button" type="button" onClick={() => onCopy("payload JSON", payloadText)}>
                <Copy size={13} aria-hidden />
                复制
              </button>
            </div>
            <pre className="json-view">{payloadText}</pre>
          </section>

          <section className="detail-section">
            <div className="detail-section-title">
              <h3>输出结果</h3>
              <button className="mini-button" type="button" onClick={() => onCopy("output JSON", outputText)} disabled={output == null}>
                <Copy size={13} aria-hidden />
                复制
              </button>
            </div>
            <pre className="json-view">{outputText}</pre>
          </section>
        </div>
      ) : null}
    </details>
  );
}
