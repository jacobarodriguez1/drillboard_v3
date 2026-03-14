/**
 * TeamInspectionPanel — shared read-only team inspection modal.
 * Used by both Judge Console and Admin Queue Manager.
 */

import type { ReactNode } from "react";
import type { TeamDetail } from "@/lib/state";

export interface TeamInspectionContext {
  padName?: string;
  /** e.g. "NOW", "ON DECK", "STANDBY" */
  queueStatus?: string;
  slotOrder?: number;
  anticipatedStart?: string;
}

interface Props {
  detail: TeamDetail;
  context?: TeamInspectionContext;
  /** When true, shows admin-only metadata section (team ID, source row IDs) */
  isAdmin?: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function TeamInspectionPanel({ detail, context, isAdmin, onClose }: Props) {
  const members = detail.members ?? [];
  const hasRoster = members.length > 0;
  const hasNotes =
    !!detail.notes ||
    (detail.warnings?.length ?? 0) > 0 ||
    (detail.constraints?.length ?? 0) > 0;
  const hasAdminMeta = isAdmin && (detail.teamId || (detail.sourceRowIds?.length ?? 0) > 0);

  const statusColor =
    context?.queueStatus === "NOW"
      ? { bg: "rgba(144,202,249,0.20)", border: "rgba(144,202,249,0.45)", fg: "#90CAF9" }
      : context?.queueStatus === "ON DECK"
        ? { bg: "rgba(255,215,64,0.15)", border: "rgba(255,215,64,0.40)", fg: "var(--cacc-gold, #FFD740)" }
        : { bg: "rgba(255,255,255,0.10)", border: "rgba(255,255,255,0.20)", fg: "rgba(255,255,255,0.75)" };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(700px, 100%)",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          borderRadius: 18,
          background: "rgba(8, 12, 26, 0.99)",
          border: "1px solid rgba(255,255,255,0.16)",
          boxShadow: "0 28px 72px rgba(0,0,0,0.70)",
          overflow: "hidden",
        }}
      >
        {/* ── Sticky header ── */}
        <div
          style={{
            padding: "14px 18px 12px",
            borderBottom: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(0,0,0,0.45)",
            flexShrink: 0,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 19,
                fontWeight: 800,
                color: "var(--text-primary, white)",
                lineHeight: 1.2,
              }}
            >
              {detail.teamDisplayName}
            </div>

            <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {context?.queueStatus ? (
                <StatusBadge bg={statusColor.bg} border={statusColor.border} fg={statusColor.fg}>
                  {context.queueStatus}
                </StatusBadge>
              ) : null}
              {context?.padName ? (
                <StatusBadge bg="rgba(255,255,255,0.07)" border="rgba(255,255,255,0.14)" fg="rgba(255,255,255,0.70)">
                  {context.padName}
                </StatusBadge>
              ) : null}
              {(detail.category || detail.division) ? (
                <span style={{ fontSize: 12, color: "rgba(255,255,255,0.50)" }}>
                  {[detail.category, detail.division].filter(Boolean).join(" — ")}
                </span>
              ) : null}
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 8,
              color: "rgba(255,255,255,0.85)",
              fontWeight: 800,
              fontSize: 14,
              width: 32,
              height: 32,
              cursor: "pointer",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* ── Context bar (slot/time info) ── */}
        {(context?.slotOrder != null || context?.anticipatedStart) ? (
          <div
            style={{
              padding: "6px 18px",
              background: "rgba(255,255,255,0.03)",
              borderBottom: "1px solid rgba(255,255,255,0.07)",
              display: "flex",
              gap: 20,
              flexWrap: "wrap",
              fontSize: 12,
              color: "rgba(255,255,255,0.45)",
              flexShrink: 0,
            }}
          >
            {context?.slotOrder != null ? <span>Slot #{context.slotOrder}</span> : null}
            {context?.anticipatedStart ? <span>Scheduled: {context.anticipatedStart}</span> : null}
          </div>
        ) : null}

        {/* ── Scrollable body ── */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 22 }}>

            {/* Team details */}
            <section>
              <SectionLabel>Team</SectionLabel>
              <div
                style={{
                  marginTop: 10,
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "8px 20px",
                }}
              >
                {detail.brigade ? <Field label="Brigade" value={detail.brigade} /> : null}
                {detail.teamNumber != null ? <Field label="Team #" value={String(detail.teamNumber)} /> : null}
                {detail.schoolName ? <Field label="School" value={detail.schoolName} wide /> : null}
                {detail.unitName ? <Field label="Unit" value={detail.unitName} wide /> : null}
                {detail.category ? <Field label="Category" value={detail.category} /> : null}
                {detail.division ? <Field label="Division" value={detail.division} /> : null}
              </div>
            </section>

            {/* Roster */}
            <Divider />
            {hasRoster ? (
              <section>
                <SectionLabel>Roster — {members.length} member{members.length !== 1 ? "s" : ""}</SectionLabel>
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 2 }}>
                  {members.map((m, i) => (
                    <div
                      key={m.memberId || i}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 12,
                        padding: "8px 10px",
                        borderRadius: 8,
                        background: i % 2 === 0 ? "rgba(255,255,255,0.04)" : "transparent",
                      }}
                    >
                      <div>
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: 14,
                            color: "var(--text-primary, white)",
                          }}
                        >
                          {m.fullName || `${m.firstName} ${m.lastName}`.trim() || "—"}
                        </span>
                        {m.role ? (
                          <span
                            style={{
                              marginLeft: 10,
                              fontSize: 11,
                              fontWeight: 700,
                              color: "rgba(255,215,64,0.85)",
                              letterSpacing: 0.5,
                            }}
                          >
                            {m.role}
                          </span>
                        ) : null}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "rgba(255,255,255,0.45)",
                          whiteSpace: "nowrap",
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                        }}
                      >
                        {[m.rank, m.grade, m.gender].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.38)", fontStyle: "italic" }}>
                No roster data — team was added manually or roster was not included in this import.
              </div>
            )}

            {/* Notes / warnings */}
            {hasNotes ? (
              <>
                <Divider />
                <section>
                  <SectionLabel>Notes</SectionLabel>
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                    {detail.notes ? (
                      <div style={{ fontSize: 13, color: "rgba(255,255,255,0.72)" }}>{detail.notes}</div>
                    ) : null}
                    {(detail.warnings ?? []).map((w, i) => (
                      <div key={i} style={{ fontSize: 12, color: "rgba(255,200,80,0.90)" }}>⚠ {w}</div>
                    ))}
                    {(detail.constraints ?? []).map((c, i) => (
                      <div key={i} style={{ fontSize: 12, color: "rgba(144,202,249,0.85)" }}>◈ {c}</div>
                    ))}
                  </div>
                </section>
              </>
            ) : null}

            {/* Admin-only reference */}
            {hasAdminMeta ? (
              <>
                <Divider />
                <section>
                  <SectionLabel>Reference (Admin)</SectionLabel>
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                    <Field label="Team ID" value={detail.teamId} mono />
                    {(detail.sourceRowIds ?? []).length > 0 ? (
                      <div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", letterSpacing: 1, marginBottom: 4 }}>
                          SOURCE ROW IDS
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            fontFamily: "ui-monospace, monospace",
                            color: "rgba(255,255,255,0.35)",
                            wordBreak: "break-all",
                            lineHeight: 1.6,
                          }}
                        >
                          {(detail.sourceRowIds ?? []).join(", ")}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </section>
              </>
            ) : null}

          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local sub-components
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: 2,
        color: "rgba(255,255,255,0.38)",
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: "rgba(255,255,255,0.08)" }} />;
}

function Field({
  label,
  value,
  wide,
  mono,
}: {
  label: string;
  value: string;
  wide?: boolean;
  mono?: boolean;
}) {
  return (
    <div style={wide ? { gridColumn: "1 / -1" } : {}}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 1.2,
          color: "rgba(255,255,255,0.38)",
          textTransform: "uppercase",
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "rgba(255,255,255,0.85)",
          fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined,
          wordBreak: mono ? "break-all" : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function StatusBadge({
  children,
  bg,
  border,
  fg,
}: {
  children: ReactNode;
  bg: string;
  border: string;
  fg: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: 0.8,
        background: bg,
        color: fg,
        border: `1px solid ${border}`,
      }}
    >
      {children}
    </span>
  );
}
