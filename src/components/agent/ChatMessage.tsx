'use client';
/**
 * @file   frontend/ChatMessage.tsx
 * @notice Individual chat message with tool call indicators.
 */

import { useState, Fragment } from "react";

// The agent's system prompt tells it to use **bold** for emphasis (e.g.
// "**All Employees**"), but nothing was ever parsing it — it rendered as
// literal asterisks in the chat bubble. This is intentionally minimal:
// just **bold**, matching the one markdown construct the prompt actually
// asks the model to use, not a full markdown renderer.
function renderWithBold(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export interface ToolCallDisplay {
  name:   string;
  args:   Record<string, unknown>;
  result: string;
}

export interface MessageProps {
  role:       "user" | "assistant";
  content:    string;
  toolCalls?: ToolCallDisplay[];
  isLoading?: boolean;
  timestamp?: string;
  /** Metadata-only (name + type) — shown as a small chip above the bubble
   *  so a sent file doesn't just vanish from the chat log. */
  attachment?: { fileName: string; mimeType: string };
}

const TOOL_META: Record<string, { label: string; icon: string }> = {
  run_payroll:          { label: "Ran Payroll",        icon: "💸" },
  pay_individual:       { label: "Individual Payment", icon: "💰" },
  get_employees:        { label: "Read Employees",     icon: "👥" },
  edit_employee:        { label: "Edited Employee",    icon: "✏️"  },
  remove_employee:      { label: "Removed Employee",   icon: "🗑️"  },
  scan_document:        { label: "Scanned Document",   icon: "📄" },
  run_compliance_check: { label: "Compliance Check",   icon: "🛡️"  },
  check_balance:        { label: "Checked Balance",    icon: "💳" },
  get_agent_status:     { label: "Agent Status",       icon: "🤖" },
  get_run_history:      { label: "Run History",        icon: "📊" },
  get_schedule:         { label: "Schedule",           icon: "📅" },
};

function ToolCallBadge({ call }: { call: ToolCallDisplay }) {
  const [open, setOpen] = useState(false);
  const meta = TOOL_META[call.name] ?? { label: call.name, icon: "⚙️" };

  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(call.result); } catch {}

  const isError   = parsed && "error" in parsed;
  const isSuccess = parsed && "success" in parsed && (parsed as {success: boolean}).success;

  return (
    <div style={{
      marginBottom: "6px",
      border:       `1px solid ${isError ? "#FECACA" : "#E2E8F0"}`,
      borderRadius: "8px",
      overflow:     "hidden",
      fontSize:     "12px",
    }}>
      <div
        onClick={() => setOpen(v => !v)}
        style={{
          display:    "flex",
          alignItems: "center",
          gap:        "8px",
          padding:    "6px 10px",
          background: isError ? "#FEF2F2" : "#F8FAFC",
          cursor:     "pointer",
        }}
      >
        <span>{meta.icon}</span>
        <span style={{ fontWeight: "600", color: isError ? "#991B1B" : "#334155" }}>
          {meta.label}
        </span>
        {isSuccess && <span style={{ marginLeft: "auto", color: "#059669" }}>✓</span>}
        {isError   && <span style={{ marginLeft: "auto", color: "#DC2626" }}>✗</span>}
        <span style={{ color: "#94A3B8", marginLeft: isSuccess || isError ? "0" : "auto" }}>
          {open ? "▲" : "▼"}
        </span>
      </div>

      {open && (
        <div style={{ padding: "10px", background: "#FFF", borderTop: "1px solid #E2E8F0" }}>
          {Object.keys(call.args).length > 0 && (
            <>
              <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748B", marginBottom: "4px" }}>
                Parameters
              </div>
              <pre style={{
                fontSize: "11px", color: "#334155", background: "#F8FAFC",
                borderRadius: "4px", padding: "6px 8px", margin: "0 0 8px", overflow: "auto",
              }}>
                {JSON.stringify(call.args, null, 2)}
              </pre>
            </>
          )}
          <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748B", marginBottom: "4px" }}>
            Result
          </div>
          <pre style={{
            fontSize: "11px",
            color:    isError ? "#991B1B" : "#334155",
            background: isError ? "#FEF2F2" : "#F8FAFC",
            borderRadius: "4px", padding: "6px 8px", margin: 0, overflow: "auto",
          }}>
            {JSON.stringify(parsed ?? call.result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          width: "6px", height: "6px", borderRadius: "50%",
          background: "#94A3B8",
          animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
        }} />
      ))}
      <style>{`@keyframes bounce{0%,80%,100%{transform:translateY(0);opacity:.5}40%{transform:translateY(-6px);opacity:1}}`}</style>
    </div>
  );
}

export default function ChatMessage({ role, content, toolCalls, isLoading, timestamp, attachment }: MessageProps) {
  const isUser = role === "user";

  return (
    <div style={{
      display:       "flex",
      flexDirection: isUser ? "row-reverse" : "row",
      gap:           "10px",
      alignItems:    "flex-start",
    }}>
      {!isUser && (
        <div style={{
          width: "64px", height: "64px",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/ai-avatar.png" alt="" width={64} height={64} style={{ objectFit: "contain" }} />
        </div>
      )}

      <div style={{ maxWidth: "75%", minWidth: "80px" }}>
        {!isUser && toolCalls && toolCalls.length > 0 && (
          <div style={{ marginBottom: "8px" }}>
            {toolCalls.map((tc, i) => <ToolCallBadge key={i} call={tc} />)}
          </div>
        )}
        {isUser && attachment && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 12, color: '#64748B', marginBottom: 4,
            justifyContent: 'flex-end',
          }}>
            📎 {attachment.fileName}
          </div>
        )}
        <div style={{
          background:   isUser ? "#4F46E5" : "#FFFFFF",
          color:        isUser ? "#FFFFFF" : "#0F172A",
          border:       isUser ? "none" : "1px solid #E2E8F0",
          borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
          padding:      "10px 14px",
          fontSize:     "14px",
          lineHeight:   "1.6",
          boxShadow:    isUser ? "none" : "0 1px 3px rgba(0,0,0,0.04)",
          whiteSpace:   "pre-wrap" as const,
          wordBreak:    "break-word" as const,
        }}>
          {isLoading ? <TypingIndicator /> : renderWithBold(content)}
        </div>
        {timestamp && (
          <div style={{
            fontSize: "10px", color: "#94A3B8",
            marginTop: "4px", textAlign: isUser ? "right" : "left",
          }}>
            {timestamp}
          </div>
        )}
      </div>
    </div>
  );
}
