"use client";

import { useState, useEffect, useRef, isValidElement } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Send,
  FileText,
  Loader2,
  LogOut,
  LayoutDashboard,
  ExternalLink,
  Plus,
  Trash2,
  MessageSquare,
} from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { api, SessionExpiredError } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

// ============================================================================
// Types
// ============================================================================

interface ChatSession {
  id: string;
  name: string;
  mode: "client" | "learner";
  created_at: string;
  updated_at: string;
}

interface Message {
  id: string;
  query: string;
  response: string;
  sources: Array<{ filename: string; page: number; similarity: number; document_id?: string }>;
  created_at: string;
}

interface StreamFinalPayload {
  type: "final";
  answer: string;
  sources: Message["sources"];
  model?: string;
  response_time_ms?: number;
  chat_saved?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

function processCitations(
  response: string,
  sources: Array<{ page: number; document_id?: string; similarity?: number }>,
): string {
  const pageToBestSource = new Map<number, { document_id: string; similarity: number }>();

  for (const s of sources) {
    if (!s.document_id) continue;
    const similarity = typeof s.similarity === "number" ? s.similarity : 0;
    const existing = pageToBestSource.get(s.page);
    if (!existing || similarity > existing.similarity) {
      pageToBestSource.set(s.page, { document_id: s.document_id, similarity });
    }
  }

  const parsePages = (citationBlock: string): number[] => {
    const content = citationBlock.slice(1, -1).replace(/^p\./i, "");
    const segments = content.split(",").map((s) => s.trim()).filter(Boolean);
    const pages: number[] = [];

    for (const segment of segments) {
      const normalized = segment.replace(/^p\./i, "").trim();
      const rangeMatch = normalized.match(/^(\d+)\s*-\s*(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
          pages.push(i);
        }
        continue;
      }

      const page = parseInt(normalized, 10);
      if (!Number.isNaN(page)) pages.push(page);
    }

    return pages;
  };

  return response.replace(/\[p\.[^\]]+\]/gi, (match) => {
    const pages = parsePages(match);
    if (pages.length === 0) return match;

    return pages.map((page) => {
      const mapped = pageToBestSource.get(page);
      return mapped
        ? `[p.${page}](cite:${mapped.document_id}:${page})`
        : `[p.${page}](cite-nolink:${page})`;
    }).join(", ");
  });
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ============================================================================
// New Session Modal
// ============================================================================

interface NewSessionModalProps {
  onClose: () => void;
  onCreate: (session: ChatSession) => void;
  onRedirect: () => void;
}

function NewSessionModal({ onClose, onCreate, onRedirect }: NewSessionModalProps) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"client" | "learner">("client");
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const session = await api.post<ChatSession>("/api/chat/sessions", {
        name: name.trim() || "New Chat",
        mode,
      });
      onCreate(session);
    } catch (error: any) {
      if (error instanceof SessionExpiredError) {
        onRedirect();
        return;
      }
      console.error("Failed to create session:", error);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6">
        <h2 className="text-lg font-semibold mb-4">New Chat</h2>

        {/* Mode toggle */}
        <p className="text-sm text-gray-500 mb-2">Mode</p>
        <div className="flex rounded-lg overflow-hidden border border-gray-200 mb-4">
          <button
            onClick={() => setMode("client")}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              mode === "client"
                ? "bg-primary text-primary-foreground"
                : "bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            Client
          </button>
          <button
            onClick={() => setMode("learner")}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              mode === "learner"
                ? "bg-primary text-primary-foreground"
                : "bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            Learner
          </button>
        </div>

        <p className="text-xs text-gray-400 mb-4">
          {mode === "client"
            ? "Concise bullet-point answers for quick reference."
            : "Expanded explanations with reasoning — ideal for learning."}
        </p>

        {/* Optional name */}
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Chat name (optional)"
          maxLength={60}
          className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary mb-4"
          onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          autoFocus
        />

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-lg border text-sm text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Chat Page
// ============================================================================

export default function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const supabase = createClient();
  const router = useRouter();

  // ---- init ----
  useEffect(() => {
    checkIfAdmin();
    loadSessions();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ---- admin check ----
  const checkIfAdmin = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      setIsAdmin(profile?.role === "admin");
    } catch {
      // non-critical
    }
  };

  // ---- sessions ----
  const loadSessions = async () => {
    setLoadingSessions(true);
    try {
      const data = await api.get<{ sessions: ChatSession[] }>("/api/chat/sessions");
      setSessions(data.sessions);
      if (data.sessions.length > 0) {
        selectSession(data.sessions[0]);
      }
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        router.push("/login");
      }
    } finally {
      setLoadingSessions(false);
    }
  };

  const selectSession = async (session: ChatSession) => {
    setActiveSession(session);
    setMessages([]);
    setLoadingHistory(true);
    try {
      const data = await api.get<{ messages: Message[] }>(
        `/api/chat/history?session_id=${session.id}&limit=50`
      );
      setMessages(data.messages.reverse());
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        router.push("/login");
      }
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleSessionCreated = (session: ChatSession) => {
    setSessions((prev) => [session, ...prev]);
    setShowNewSessionModal(false);
    selectSession(session);
  };

  const handleDeleteSession = async (sessionId: string) => {
    setDeletingId(sessionId);
    try {
      await api.delete(`/api/chat/sessions/${sessionId}`);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSession?.id === sessionId) {
        setActiveSession(null);
        setMessages([]);
      }
    } catch (error) {
      console.error("Failed to delete session:", error);
    } finally {
      setDeletingId(null);
    }
  };

  // ---- messaging ----
  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading || !activeSession) return;

    const queryText = input.trim();
    setInput("");
    setLoading(true);
    const tempId = `tmp-${Date.now()}`;

    const pendingMessage: Message = {
      id: tempId,
      query: queryText,
      response: "",
      sources: [],
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, pendingMessage]);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new SessionExpiredError();

      const response = await fetch(`${API_URL}/api/chat/message/stream`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: queryText, session_id: activeSession.id }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || `Request failed: ${response.status}`);
      }

      if (!response.body) {
        throw new Error("Streaming response is unavailable.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalPayload: StreamFinalPayload | null = null;

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf("\n");
          if (!line) continue;

          const event = JSON.parse(line) as {
            type: "delta" | "final" | "error";
            delta?: string;
            error?: string;
            answer?: string;
            sources?: Message["sources"];
            model?: string;
            response_time_ms?: number;
            chat_saved?: boolean;
          };

          if (event.type === "delta" && event.delta) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempId ? { ...m, response: m.response + event.delta } : m
              )
            );
            continue;
          }

          if (event.type === "error") {
            throw new Error(event.error || "Stream failed.");
          }

          if (event.type === "final") {
            finalPayload = event as StreamFinalPayload;
          }
        }

        if (done) break;
      }

      if (!finalPayload) {
        throw new Error("Stream ended before final response.");
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempId
            ? {
                ...m,
                response: finalPayload!.answer,
                sources: finalPayload!.sources || [],
              }
            : m
        )
      );

      // Bump session to top of list
      setSessions((prev) => {
        const updated = prev.map((s) =>
          s.id === activeSession.id ? { ...s, updated_at: new Date().toISOString() } : s
        );
        return [...updated].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
      });
    } catch (error: any) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      if (error instanceof SessionExpiredError) {
        router.push("/login");
        return;
      }
      console.error("Send message error:", error);
      alert(error.message || "Failed to send message");
    } finally {
      setLoading(false);
    }
  };

  // ---- document viewer ----
  const openDocumentPage = async (source: { document_id?: string; page: number }) => {
    if (!source.document_id) return;
    try {
      const data = await api.get<{ url: string }>(
        `/api/chat/document-url/${source.document_id}`
      );
      if (data.url) {
        window.open(
          `/view-document?url=${encodeURIComponent(data.url)}&page=${source.page}`,
          "_blank",
          "noopener,noreferrer"
        );
      }
    } catch (error) {
      console.error("Failed to open document:", error);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* ------------------------------------------------------------------ */}
      {/* Sidebar */}
      {/* ------------------------------------------------------------------ */}
      <div className="w-64 shrink-0 bg-white border-r flex flex-col">
        {/* Sidebar header */}
        <div className="p-4 border-b">
          <button
            onClick={() => setShowNewSessionModal(true)}
            className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-lg py-2 px-3 text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Chat
          </button>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto py-2">
          {loadingSessions ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-8 px-4">
              No chats yet. Click "New Chat" to start.
            </p>
          ) : (
            sessions.map((session) => (
              <div
                key={session.id}
                onClick={() => selectSession(session)}
                className={`group relative flex items-start gap-2 px-3 py-2.5 mx-2 rounded-lg cursor-pointer transition-colors ${
                  activeSession?.id === session.id
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-gray-100 text-gray-700"
                }`}
              >
                <MessageSquare className="w-4 h-4 mt-0.5 shrink-0 opacity-60" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{session.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                        session.mode === "learner"
                          ? "bg-purple-100 text-purple-600"
                          : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {session.mode}
                    </span>
                    <span className="text-xs text-gray-400">
                      {formatRelativeTime(session.updated_at)}
                    </span>
                  </div>
                </div>
                {/* Delete button */}
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteSession(session.id); }}
                  disabled={deletingId === session.id}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 hover:text-red-500 transition-all shrink-0"
                  title="Delete chat"
                >
                  {deletingId === session.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            ))
          )}
        </div>

        {/* Sidebar footer: logout */}
        <div className="border-t p-3">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800 px-2 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Main area */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="bg-white border-b px-6 py-4 flex justify-between items-center shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">
              {activeSession ? activeSession.name : "AI Assistant"}
            </h1>
            {activeSession && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  activeSession.mode === "learner"
                    ? "bg-purple-100 text-purple-600"
                    : "bg-gray-100 text-gray-500"
                }`}
              >
                {activeSession.mode === "learner" ? "Learner Mode" : "Client Mode"}
              </span>
            )}
          </div>
          {isAdmin && (
            <Link
              href="/admin/dashboard"
              className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
            >
              <LayoutDashboard className="w-4 h-4" />
              Dashboard
            </Link>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto py-6">
          <div className="max-w-3xl mx-auto px-6 space-y-6">
            {!activeSession ? (
              <div className="flex flex-col items-center justify-center py-24 text-gray-400">
                <MessageSquare className="w-16 h-16 mb-4" />
                <p className="text-lg font-medium mb-1">No chat selected</p>
                <p className="text-sm">Create a new chat from the sidebar to get started.</p>
              </div>
            ) : loadingHistory ? (
              <div className="flex justify-center items-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                <FileText className="w-16 h-16 mb-4" />
                <p>Ask a question to start the conversation</p>
              </div>
            ) : (
              messages.map((message) => (
                <div key={message.id} className="space-y-4">
                  {/* User query */}
                  <div className="flex justify-end">
                    <div className="bg-primary text-primary-foreground rounded-2xl px-4 py-3 max-w-[75%] text-sm leading-relaxed">
                      {message.query}
                    </div>
                  </div>

                  {/* Bot response */}
                  <div className="flex justify-start">
                    <div className="bg-white rounded-2xl px-5 py-4 max-w-[85%] shadow-sm text-sm text-gray-800">
                      <div className="prose prose-sm max-w-none prose-li:my-0.5 prose-headings:mb-2">
                        <ReactMarkdown
                          urlTransform={(url) => {
                            if (url.startsWith("cite:") || url.startsWith("cite-nolink:")) return url;
                            return defaultUrlTransform(url);
                          }}
                          components={{
                            p: ({ children }) => {
                              const arr = Array.isArray(children) ? children : [children];
                              const first = arr[0];
                              const isHeader =
                                isValidElement(first) &&
                                (first as React.ReactElement).type === "strong";
                              return (
                                <p className={isHeader ? "mt-5 mb-2" : "my-3 leading-relaxed"}>{children}</p>
                              );
                            },
                            a: ({ href, children }) => {
                              if (href?.startsWith("cite:")) {
                                const [docId, pageStr] = href.slice(5).split(":");
                                const page = parseInt(pageStr, 10);
                                return (
                                  <button
                                    onClick={(e) => {
                                      e.preventDefault();
                                      openDocumentPage({ document_id: docId, page });
                                    }}
                                    className="inline-flex items-center gap-0.5 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5 text-xs text-blue-600 hover:bg-blue-100 font-medium mx-0.5 align-middle not-prose"
                                  >
                                    <FileText className="w-3 h-3" />
                                    {children}
                                  </button>
                                );
                              }
                              if (href?.startsWith("cite-nolink:")) {
                                return (
                                  <span className="inline-flex items-center gap-0.5 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5 text-xs text-gray-500 font-medium mx-0.5 align-middle not-prose">
                                    <FileText className="w-3 h-3" />
                                    {children}
                                  </span>
                                );
                              }
                              return (
                                <a href={href} target="_blank" rel="noopener noreferrer">
                                  {children}
                                </a>
                              );
                            },
                          }}
                        >
                          {processCitations(message.response, message.sources)}
                        </ReactMarkdown>
                      </div>

                      {/* Sources */}
                      {message.sources && message.sources.length > 0 && (
                        <div className="mt-4 pt-3 border-t border-gray-100">
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                            Sources
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {message.sources.map((source, idx) => (
                              <button
                                key={idx}
                                onClick={() => openDocumentPage(source)}
                                disabled={!source.document_id}
                                className="inline-flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-md px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100 hover:border-gray-300 disabled:cursor-default disabled:hover:bg-gray-50 disabled:hover:border-gray-200 transition-colors"
                              >
                                <FileText className="w-3 h-3 shrink-0 text-gray-400" />
                                <span className="font-medium">{source.filename}</span>
                                <span className="text-gray-400">· p.{source.page}</span>
                                {source.document_id && (
                                  <ExternalLink className="w-3 h-3 shrink-0 text-gray-400" />
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-white rounded-2xl px-5 py-4 shadow-sm">
                  <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input */}
        <div className="bg-white border-t p-4 shrink-0">
          <form onSubmit={sendMessage} className="max-w-3xl mx-auto flex gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={activeSession ? "Ask a question..." : "Select or create a chat to begin"}
              disabled={loading || !activeSession}
              className="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={loading || !input.trim() || !activeSession}
              className="bg-primary text-primary-foreground px-6 py-2 rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Send className="w-4 h-4" />
              Send
            </button>
          </form>
        </div>
      </div>

      {/* New session modal */}
      {showNewSessionModal && (
        <NewSessionModal
          onClose={() => setShowNewSessionModal(false)}
          onCreate={handleSessionCreated}
          onRedirect={() => router.push("/login")}
        />
      )}
    </div>
  );
}
