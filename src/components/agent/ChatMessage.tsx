'use client';
/**
 * @file   frontend/ChatMessage.tsx
 * @notice Individual chat message with tool call indicators.
 */

import { useState } from "react";

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

export default function ChatMessage({ role, content, toolCalls, isLoading, timestamp }: MessageProps) {
  const isUser = role === "user";

  return (
    <div style={{
      display:       "flex",
      flexDirection: isUser ? "row-reverse" : "row",
      gap:           "10px",
      marginBottom:  "16px",
      alignItems:    "flex-start",
    }}>
      {!isUser && (
        <div style={{
          width: "32px", height: "32px", borderRadius: "50%",
          background: "#FAFAF8",
          border: "1px solid #F1F5F9",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, overflow: "hidden",
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/ai-avatar.png" alt="" width={22} height={22} style={{ objectFit: "contain" }} />
        </div>
      )}

      <div style={{ maxWidth: "75%", minWidth: "80px" }}>
        {!isUser && toolCalls && toolCalls.length > 0 && (
          <div style={{ marginBottom: "8px" }}>
            {toolCalls.map((tc, i) => <ToolCallBadge key={i} call={tc} />)}
          </div>
        )}
        <div style={{
          background:   isUser ? "#1E3A5F" : "#FFFFFF",
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
          {isLoading ? <TypingIndicator /> : content}
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
