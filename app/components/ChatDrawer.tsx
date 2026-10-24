"use client";

/**
 * Interactive AI Assistant Chat Drawer (T8.3–T8.4).
 * Talks ONLY to /api/ai/chat — never to any external AI provider (AT-11).
 * Every assistant answer is tagged "AI-generated"; tool executions are shown
 * as transparent chips; the role switch resets the conversation.
 */

import {
  AlertTriangle,
  Bot,
  Loader2,
  MessageSquare,
  Send,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import type { Role } from "@/lib/types";

interface ChatMsg {
  id: string;
  from: "user" | "ai";
  text: string;
  tools?: { name: string; status: string }[];
  degraded?: string;
  isError?: boolean;
  at: string;
}

const SUGGESTIONS: { label: string; msg: string; tag?: string }[] = [
  {
    label: "How many active employees are in Engineering?",
    msg: "How many active employees are in Engineering?",
    tag: "AT-01",
  },
  {
    label: "Who came late most often this month?",
    msg: "Who came late most often this month?",
    tag: "AT-02",
  },
  {
    label: "What is this month's attendance rate?",
    msg: "What is this month's attendance rate?",
    tag: "AT-03",
  },
  {
    label: "How many sick leaves do I have left this year?",
    msg: "How many sick leaves do I have left this year?",
    tag: "AT-04",
  },
  {
    label: "What is Ahmed's salary?",
    msg: "What is Ahmed's salary?",
    tag: "AT-05 privacy",
  },
];

const STATUS_STYLES: Record<string, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  forbidden: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  error: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  not_found: "border-slate-500/30 bg-slate-500/10 text-slate-300",
  ambiguous: "border-slate-500/30 bg-slate-500/10 text-slate-300",
};

export default function ChatDrawer({
  open,
  onClose,
  sessionEmail,
  role,
  userName,
}: {
  open: boolean;
  onClose: () => void;
  sessionEmail: string;
  role: Role;
  userName: string;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // Reset the conversation when the active seat changes (state adjustment
  // during render — the React-recommended alternative to an effect).
  const [prevSeat, setPrevSeat] = useState(sessionEmail);
  if (prevSeat !== sessionEmail) {
    setPrevSeat(sessionEmail);
    setMessages([]);
    setInput("");
  }
  const conversationIdRef = useRef<string | null>(null);
  const getConversationId = () => {
    if (!conversationIdRef.current) {
      conversationIdRef.current = `conv-${crypto.randomUUID().slice(0, 8)}`;
    }
    return conversationIdRef.current;
  };
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      setInput("");
      setSending(true);
      setMessages((m) => [
        ...m,
        { id: `u-${Date.now()}`, from: "user", text: trimmed, at: new Date().toISOString() },
      ]);
      try {
        const res = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-user-email": sessionEmail },
          body: JSON.stringify({ message: trimmed, conversation_id: getConversationId() }),
        });
        const body = await res.json();
        if (!res.ok) {
          // Show the failure inside the conversation, not just as a toast.
          setMessages((m) => [
            ...m,
            {
              id: `e-${Date.now()}`,
              from: "ai",
              text: body.error ?? "The assistant is unavailable right now. Please try again shortly.",
              isError: true,
              at: new Date().toISOString(),
            },
          ]);
          return;
        }
        setMessages((m) => [
          ...m,
          {
            id: `a-${Date.now()}`,
            from: "ai",
            text: body.reply as string,
            tools: body.tools_used,
            degraded: body.degraded,
            at: body.generated_at ?? new Date().toISOString(),
          },
        ]);
      } catch {
        toast.error("Network error — the assistant could not be reached.");
      } finally {
        setSending(false);
      }
    },
    [sending, sessionEmail],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <aside
        className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-slate-800 bg-slate-950 shadow-2xl"
        role="dialog"
        aria-label="AI Assistant chat"
      >
        {/* header */}
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/20 text-indigo-300">
              <Bot className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-100">HCM Lite Assistant</p>
              <p className="text-[11px] text-slate-500">
                Signed in as {userName} · {role} · internal gateway only
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
            aria-label="Close chat"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* messages */}
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {messages.length === 0 && !sending && (
            <div className="space-y-3">
              <div className="rounded-2xl rounded-tl-sm border border-slate-800 bg-slate-900 p-4">
                <p className="text-sm leading-relaxed text-slate-200">
                  👋 Hello {userName.split(" ")[0]}! I&apos;m the HCM Lite assistant. I answer
                  strictly from company data via governed tools — and I never disclose
                  salaries. Try one of the questions below.
                </p>
              </div>
              <div className="space-y-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => send(s.msg)}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/70 px-3.5 py-2.5 text-left text-sm text-slate-200 transition hover:border-indigo-500/50 hover:bg-slate-800/70"
                  >
                    <span>{s.label}</span>
                    {s.tag && (
                      <span className="shrink-0 rounded-full border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
                        {s.tag}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className={m.from === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[85%] space-y-1.5 ${
                  m.from === "user"
                    ? "rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2.5 text-sm text-white"
                    : m.isError
                      ? "rounded-2xl rounded-tl-sm border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
                      : "rounded-2xl rounded-tl-sm border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-slate-200"
                }`}
              >
                <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
                {m.from === "ai" && !m.isError && (
                  <>
                    {m.tools && m.tools.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {m.tools.map((t, i) => (
                          <span
                            key={`${t.name}-${i}`}
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                              STATUS_STYLES[t.status] ?? STATUS_STYLES.not_found
                            }`}
                          >
                            <Wrench className="h-2.5 w-2.5" />
                            {t.name} · {t.status}
                          </span>
                        ))}
                      </div>
                    )}
                    {m.degraded && (
                      <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        {m.degraded}
                      </p>
                    )}
                    <p className="inline-flex items-center gap-1 pt-0.5 text-[10px] text-slate-500">
                      <Sparkles className="h-2.5 w-2.5" /> AI-generated
                    </p>
                  </>
                )}
              </div>
            </div>
          ))}

          {sending && (
            <div className="flex justify-start">
              <div className="w-40 space-y-2 rounded-2xl rounded-tl-sm border border-slate-800 bg-slate-900 px-4 py-3">
                <div className="h-2.5 w-full animate-pulse rounded bg-slate-800" />
                <div className="h-2.5 w-4/5 animate-pulse rounded bg-slate-800" />
                <div className="h-2.5 w-3/5 animate-pulse rounded bg-slate-800" />
              </div>
            </div>
          )}
        </div>

        {/* input */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex items-center gap-2 border-t border-slate-800 px-4 py-3"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              role === "Employee"
                ? "Ask about your leave or search the directory…"
                : "Ask about headcount, attendance, leave or payroll…"
            }
            className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
            maxLength={500}
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white transition hover:bg-indigo-500 disabled:opacity-40"
            aria-label="Send message"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </form>
        <p className="flex items-center justify-center gap-1.5 pb-3 text-[10px] text-slate-600">
          <MessageSquare className="h-3 w-3" />
          Calls only /api/ai/chat on this server — zero external AI calls from your browser.
        </p>
      </aside>
    </div>
  );
}
