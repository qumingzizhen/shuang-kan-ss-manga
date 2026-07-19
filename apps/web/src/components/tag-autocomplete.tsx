"use client";

import { KeyboardEvent, useId, useMemo, useState } from "react";
import { Search, Tags } from "lucide-react";
import {
  activeTagFragment,
  replaceActiveTagFragment,
  suggestTags,
  type TagTranslation,
} from "@/lib/tag-system";

type TagAutocompleteProps = {
  value: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  excludedCanonical?: string[];
  multiline?: boolean;
  placeholder?: string;
  ariaLabel: string;
};

export function TagAutocomplete({
  value,
  onChange,
  onCommit,
  excludedCanonical = [],
  multiline = false,
  placeholder,
  ariaLabel,
}: TagAutocompleteProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const fragment = activeTagFragment(value).text;
  const suggestions = useMemo(() => suggestTags(fragment, excludedCanonical), [excludedCanonical, fragment]);
  const visible = open && suggestions.length > 0;

  function selectSuggestion(suggestion: TagTranslation) {
    if (onCommit) {
      onCommit(suggestion.canonical);
      onChange("");
    } else {
      onChange(replaceActiveTagFragment(value, suggestion));
    }
    setOpen(false);
    setActiveIndex(0);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (visible && event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % suggestions.length);
      return;
    }
    if (visible && event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (visible && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      selectSuggestion(suggestions[activeIndex] ?? suggestions[0]);
      return;
    }
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (onCommit && event.key === "Enter") {
      event.preventDefault();
      onCommit(value);
      onChange("");
    }
  }

  const commonProps = {
    value,
    placeholder,
    role: "combobox",
    "aria-label": ariaLabel,
    "aria-autocomplete": "list" as const,
    "aria-controls": listboxId,
    "aria-expanded": visible,
    "aria-activedescendant": visible ? `${listboxId}-${activeIndex}` : undefined,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(event.target.value);
      setOpen(true);
      setActiveIndex(0);
    },
    onFocus: () => setOpen(true),
    onBlur: () => window.setTimeout(() => setOpen(false), 120),
    onKeyDown: handleKeyDown,
  };

  return (
    <div className="tag-autocomplete">
      <div className="tag-autocomplete-input-wrap">
        {multiline ? <Tags size={15} aria-hidden /> : <Search size={15} aria-hidden />}
        {multiline ? <textarea className="textarea tag-autocomplete-input" {...commonProps} /> : <input className="input tag-autocomplete-input" {...commonProps} />}
      </div>
      {visible ? (
        <div className="tag-suggestion-list" id={listboxId} role="listbox" aria-label="词条建议">
          {suggestions.map((suggestion, index) => (
            <button
              className={index === activeIndex ? "tag-suggestion active" : "tag-suggestion"}
              id={`${listboxId}-${index}`}
              key={suggestion.canonical}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectSuggestion(suggestion)}
            >
              <span>{suggestion.zh}</span>
              <strong>{suggestion.canonical}</strong>
              {suggestion.aliases[0] ? <small>{suggestion.aliases[0]}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
