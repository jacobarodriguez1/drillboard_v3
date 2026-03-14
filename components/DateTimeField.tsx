"use client";

import { useRef } from "react";

type DateTimeFieldProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  /** When true, wrapper uses fit-content instead of 100% width (e.g. flex row) */
  inline?: boolean;
};

const CalendarIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);

export function DateTimeField({
  value,
  onChange,
  disabled = false,
  style,
  className = "",
  placeholder,
  ariaLabel,
  inline = false,
}: DateTimeFieldProps) {
  const ref = useRef<HTMLInputElement>(null);

  const openPicker = () => {
    const el = ref.current;
    if (!el || disabled) return;
    el.focus();
    (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
  };

  const handleWrapperClick = () => {
    openPicker();
  };

  const handleBtnClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openPicker();
  };

  const wrapClass = `dt-wrap ${inline ? "dt-wrap-inline" : ""} ${className}`.trim();

  return (
    <div
      className={wrapClass}
      onClick={handleWrapperClick}
      role="presentation"
    >
      <input
        ref={ref}
        type="datetime-local"
        className="dt-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ ...style, paddingRight: 44 }}
        placeholder={placeholder}
        aria-label={ariaLabel ?? "Date and time"}
      />
      <button
        type="button"
        className="dt-btn"
        aria-label="Open calendar"
        onClick={handleBtnClick}
        disabled={disabled}
        tabIndex={-1}
      >
        <CalendarIcon />
      </button>
    </div>
  );
}
