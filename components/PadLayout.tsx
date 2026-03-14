/**
 * Shared pad layout structure for Public, Judge, and Admin.
 * BOLD CLARITY: 3-level luminance ladder, hard section separation, primary dominance.
 * Variant: display (larger, Public) | operational (Judge) | control (Admin, compact)
 */

import type { ReactNode } from "react";

export type PadLayoutVariant = "display" | "operational" | "control";

const VARIANT = {
  display: {
    padNameSize: 20,
    subtitleSize: 12,
    sectionGap: 14,
    padding: 18,
    borderRadius: 12,
    primaryPadding: "16px 18px",
    primaryFontSize: 24,
    timerFontSize: 20,
    onDeckFontSize: 15,
    standbyFontSize: 13,
  },
  operational: {
    padNameSize: 18,
    subtitleSize: 12,
    sectionGap: 12,
    padding: 16,
    borderRadius: 10,
    primaryPadding: "14px 16px",
    primaryFontSize: 19,
    timerFontSize: 17,
    onDeckFontSize: 14,
    standbyFontSize: 12,
  },
  control: {
    padNameSize: 14,
    subtitleSize: 11,
    sectionGap: 10,
    padding: 12,
    borderRadius: 8,
    primaryPadding: "11px 13px",
    primaryFontSize: 15,
    timerFontSize: 13,
    onDeckFontSize: 13,
    standbyFontSize: 11,
  },
};

/** Level 1: pad container - clearly lighter than page, crisp border, one shadow */
export function PadContainer({
  variant = "display",
  statusBg,
  children,
  style,
}: {
  variant?: PadLayoutVariant;
  statusBg: string;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  const v = VARIANT[variant];
  return (
    <div
      style={{
        borderRadius: v.borderRadius + 4,
        overflow: "hidden",
        background: "var(--surface-1)",
        border: "1px solid var(--border-crisp)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
        ...style,
      }}
    >
      <div style={{ height: 4, background: statusBg }} />
      <div style={{ padding: v.padding }}>{children}</div>
    </div>
  );
}

export function PadHeader({
  variant = "display",
  padName,
  subtitle,
  nextScheduled,
  statusPill,
  updatedAt,
}: {
  variant?: PadLayoutVariant;
  padName: string;
  subtitle?: string;
  nextScheduled?: string;
  statusPill: ReactNode;
  updatedAt?: string;
}) {
  const v = VARIANT[variant];
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div
          style={{
            fontSize: v.padNameSize,
            fontWeight: 1000,
            color: "var(--text-primary)",
          }}
        >
          {padName}
        </div>
        {subtitle ? (
          <div
            style={{ fontSize: v.subtitleSize, color: "var(--text-secondary)" }}
          >
            {subtitle}
          </div>
        ) : null}
        {nextScheduled ? (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
            Next: {nextScheduled}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          alignItems: "flex-end",
        }}
      >
        {statusPill}
        {updatedAt ? (
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
            {updatedAt}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Hard 1px divider between sections */
export function PadSectionDivider() {
  return (
    <div
      style={{
        height: 1,
        background: "var(--divider)",
        margin: "12px 0",
      }}
    />
  );
}

/** Level 2: primary section - dominant, most breathing room, crisp edges */
export function PadPrimarySection({
  variant = "display",
  statusAccent,
  statusBadge,
  timer,
  competitorContent,
  subContent,
  padMessage,
  style,
  lateFlash,
  bannerOverrides,
  actions,
}: {
  variant?: PadLayoutVariant;
  statusAccent: string;
  statusBadge: ReactNode;
  timer?: ReactNode;
  competitorContent: ReactNode;
  subContent?: ReactNode;
  padMessage?: string;
  style?: React.CSSProperties;
  lateFlash?: boolean;
  bannerOverrides?: { background?: string; border?: string };
  actions?: ReactNode;
}) {
  const v = VARIANT[variant];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "6px 1fr",
        borderRadius: 6,
        overflow: "hidden",
        background: bannerOverrides?.background ?? "var(--surface-2)",
        border: bannerOverrides?.border ?? "1px solid var(--border-crisp)",
        ...style,
        ...(lateFlash
          ? { animation: "lateFlash 1.0s ease-in-out infinite" as const }
          : {}),
      }}
    >
      <div style={{ background: statusAccent }} />
      <div style={{ padding: v.primaryPadding }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            {statusBadge}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            {timer ? (
              <div
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: v.timerFontSize,
                  fontWeight: 1100,
                  color: "var(--text-primary)",
                }}
              >
                {timer}
              </div>
            ) : null}
            {actions ?? null}
          </div>
        </div>
        {padMessage ? (
          <div
            style={{
              marginTop: 8,
              fontSize: v.padNameSize - 2,
              fontWeight: 950,
              color: "var(--text-secondary)",
            }}
          >
            {padMessage}
          </div>
        ) : null}
        <div
          style={{
            marginTop: padMessage ? 8 : 10,
            fontSize: v.primaryFontSize,
            fontWeight: 1000,
            lineHeight: 1.25,
            color: "var(--text-primary)",
          }}
        >
          {competitorContent}
        </div>
        {subContent ? (
          <div
            style={{
              marginTop: 8,
              fontSize: v.subtitleSize,
              color: "var(--text-tertiary)",
            }}
          >
            {subContent}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Level 1.5: on deck - secondary, hard divider, smaller text */
export function PadOnDeckSection({
  variant = "display",
  label = "ON DECK",
  labelRight = "NEXT",
  children,
  actions,
}: {
  variant?: PadLayoutVariant;
  label?: string;
  labelRight?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const v = VARIANT[variant];
  return (
    <>
      <div
        style={{
          height: 1,
          background: "var(--divider)",
          marginTop: v.sectionGap,
        }}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "6px 1fr",
          borderRadius: 6,
          overflow: "hidden",
          background: "var(--surface-1-5)",
          border: "1px solid rgba(255,255,255,0.08)",
          marginTop: 0,
        }}
      >
        <div style={{ background: "rgba(255,255,255,0.12)" }} />
        <div style={{ padding: "10px 12px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  height: 20,
                  padding: "0 8px",
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 1000,
                  letterSpacing: 1,
                  background: "rgba(255,255,255,0.10)",
                  color: "var(--text-secondary)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  textTransform: "uppercase",
                }}
              >
                {label}
              </span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 900,
                  letterSpacing: 1,
                  color: "var(--text-tertiary)",
                }}
              >
                {labelRight}
              </span>
            </div>
            {actions ?? null}
          </div>
          <div
            style={{
              marginTop: 8,
              fontSize: v.onDeckFontSize,
              fontWeight: 900,
              color: "var(--text-secondary)",
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </>
  );
}

/** Level 1.25: standby - quietest, smallest text */
export function PadStandbySection({
  variant = "display",
  count,
  children,
}: {
  variant?: PadLayoutVariant;
  count: number;
  children: ReactNode;
}) {
  const v = VARIANT[variant];
  return (
    <>
      <div
        style={{
          height: 1,
          background: "var(--divider)",
          marginTop: v.sectionGap,
        }}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "6px 1fr",
          borderRadius: 6,
          overflow: "hidden",
          background: "var(--surface-1-25)",
          border: "1px solid rgba(255,255,255,0.05)",
          marginTop: 0,
        }}
      >
        <div style={{ background: "rgba(255,255,255,0.08)" }} />
        <div style={{ padding: "10px 12px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: 10,
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                height: 20,
                padding: "0 8px",
                borderRadius: 4,
                fontSize: 10,
                fontWeight: 1000,
                letterSpacing: 1,
                background: "rgba(255,255,255,0.06)",
                color: "var(--text-tertiary)",
                border: "1px solid rgba(255,255,255,0.05)",
                textTransform: "uppercase",
              }}
            >
              STANDBY
            </span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: 1,
                color: "var(--text-tertiary)",
              }}
            >
              {count} waiting
            </span>
          </div>
          <div
            style={{
              marginTop: 8,
              fontSize: v.standbyFontSize,
              color: "var(--text-tertiary)",
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </>
  );
}
