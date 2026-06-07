"use client";

import { useState, useEffect, useRef, isValidElement } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Send,
  FileText,
  Loader2,
  LogOut,
  ArrowLeft,
  ExternalLink,
  Plus,
  Trash2,
  MessageSquare,
} from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { api, SessionExpiredError } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

// ============================================================================
// Types
// ============================================================================

interface ChatSession {
  id: string;
  name: string;
  mode: "client" | "learner" | "agent";
  created_at: string;
  updated_at: string;
}

interface Message {
  id: string;
  query: string;
  response: string;
  sources: Array<{
    filename: string;
    page: number;
    similarity: number;
    document_id?: string;
    text?: string;
    ref?: number;
  }>;
  created_at: string;
  stop_reason?: string;
  iterations?: number;
  cost_usd?: number;
  total_tokens?: number;
}

interface StreamFinalPayload {
  type: "final";
  answer: string;
  sources: Message["sources"];
  model?: string;
  response_time_ms?: number;
  chat_saved?: boolean;
  stop_reason?: string;
  iterations?: number;
  cost_usd?: number;
  total_tokens?: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Converts single newlines into Markdown hard breaks (two trailing spaces + newline)
 * so that line-by-line data rows render on separate lines instead of collapsing into one paragraph.
 * Preserves existing double-newlines (paragraph breaks) and list items.
 */
function preserveLineBreaks(text: string): string {
  return text.replace(/([^\n])\n(?!\n|\s*[-*]\s|\s*\d+\.\s|#)/g, "$1  \n");
}

function processCitations(
  response: string,
  sources: Array<{
    page: number;
    document_id?: string;
    similarity?: number;
    ref?: number;
  }>,
): string {
  // Build lookup: ref number -> source with document_id
  const refToSource = new Map<number, { document_id: string; page: number }>();
  for (const s of sources) {
    if (s.ref != null && s.document_id) {
      refToSource.set(s.ref, { document_id: s.document_id, page: s.page });
    }
  }

  // Replace [N] citations with clickable links
  return response.replace(/\[(\d+)\]/g, (match, numStr: string) => {
    const refNum = parseInt(numStr, 10);
    const mapped = refToSource.get(refNum);
    if (mapped) {
      return `[\[${refNum}\]](cite:${mapped.document_id}:${mapped.page})`;
    }
    // No source for this ref — render as plain text
    return match;
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

function NewSessionModal({
  onClose,
  onCreate,
  onRedirect,
}: NewSessionModalProps) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"client" | "learner" | "agent">("client");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const session = await api.post<ChatSession>("/api/chat/sessions", {
        name: name.trim() || "New Chat",
        mode,
      });
      onCreate(session);
    } catch (err: any) {
      if (err instanceof SessionExpiredError) {
        onRedirect();
        return;
      }
      console.error("Failed to create session:", err);
      setError(err.message || "Failed to create chat. Please try again.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60'>
      <div className='bg-[#1F1F1F] rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 border border-[#2B2B2B]'>
        <h2 className='text-lg font-semibold font-heading text-white mb-4'>
          New Chat
        </h2>

        {/* Mode toggle */}
        <p className='text-sm text-gray-400 mb-2'>Mode</p>
        <div className='flex rounded-lg overflow-hidden border border-[#2B2B2B] mb-4'>
          <button
            onClick={() => setMode("client")}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              mode === "client"
                ? "bg-gold-gradient text-black"
                : "bg-[#141414] text-gray-400 hover:bg-[#2B2B2B]"
            }`}
          >
            Client
          </button>
          <button
            onClick={() => setMode("learner")}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              mode === "learner"
                ? "bg-gold-gradient text-black"
                : "bg-[#141414] text-gray-400 hover:bg-[#2B2B2B]"
            }`}
          >
            Learner
          </button>
          <button
            onClick={() => setMode("agent")}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              mode === "agent"
                ? "bg-gold-gradient text-black"
                : "bg-[#141414] text-gray-400 hover:bg-[#2B2B2B]"
            }`}
          >
            Agent
          </button>
        </div>

        <p className='text-xs text-gray-500 mb-4'>
          {mode === "client"
            ? "Concise bullet-point answers for quick reference."
            : mode === "learner"
              ? "Expanded explanations with reasoning — ideal for learning."
              : "AI searches and reasons step-by-step — best for complex questions."}
        </p>

        {/* Optional name */}
        <input
          type='text'
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='Chat name (optional)'
          maxLength={60}
          className='w-full px-3 py-2 bg-[#141414] border border-[#2B2B2B] rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gold mb-4'
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreate();
          }}
          autoFocus
        />

        {error && <p className='text-xs text-red-400 mb-3'>{error}</p>}

        <div className='flex gap-3'>
          <button
            onClick={onClose}
            className='flex-1 py-2 rounded-lg border border-[#2B2B2B] text-sm text-gray-400 hover:bg-[#2B2B2B] transition-colors'
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating}
            className='flex-1 py-2 rounded-lg bg-gold-gradient text-black text-sm font-semibold hover:shadow-gold-glow disabled:opacity-50 flex items-center justify-center gap-2 transition-shadow'
          >
            {creating ? <Loader2 className='w-4 h-4 animate-spin' /> : null}
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
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
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
      const {
        data: { user },
      } = await supabase.auth.getUser();
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
      const data = await api.get<{ sessions: ChatSession[] }>(
        "/api/chat/sessions",
      );
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
        `/api/chat/history?session_id=${session.id}&limit=50`,
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
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new SessionExpiredError();

      const response = await fetch(`${API_URL}/api/chat/message/stream`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: queryText,
          session_id: activeSession.id,
        }),
      });

      if (!response.ok) {
        const body = await response
          .json()
          .catch(() => ({}) as { error?: string });
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
            type: "start" | "status" | "delta" | "final" | "error";
            step?: string;
            label?: string;
            intent?: string;
            delta?: string;
            error?: string;
            answer?: string;
            sources?: Message["sources"];
            model?: string;
            response_time_ms?: number;
            chat_saved?: boolean;
          };

          if (event.type === "status" && event.label) {
            setStreamStatus(event.label);
            continue;
          }

          if (event.type === "delta" && event.delta) {
            setStreamStatus(null); // clear status once answer starts streaming
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempId
                  ? { ...m, response: m.response + event.delta }
                  : m,
              ),
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
                stop_reason: finalPayload!.stop_reason,
                iterations: finalPayload!.iterations,
                cost_usd: finalPayload!.cost_usd,
                total_tokens: finalPayload!.total_tokens,
              }
            : m,
        ),
      );

      // Bump session to top of list
      setSessions((prev) => {
        const updated = prev.map((s) =>
          s.id === activeSession.id
            ? { ...s, updated_at: new Date().toISOString() }
            : s,
        );
        return [...updated].sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
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
      setStreamStatus(null);
    }
  };

  // ---- document viewer ----
  const openDocumentPage = async (source: {
    document_id?: string;
    page: number;
    text?: string;
  }) => {
    if (!source.document_id) return;
    try {
      const data = await api.get<{ url: string }>(
        `/api/chat/document-url/${source.document_id}`,
      );
      if (data.url) {
        // Store chunk text in localStorage so the viewer can display it as a highlight
        const highlightKey = `doc-highlight-${Date.now()}`;
        if (source.text) {
          localStorage.setItem(highlightKey, source.text);
        }
        const highlightParam = source.text
          ? `&highlight=${encodeURIComponent(highlightKey)}`
          : "";
        window.open(
          `/view-document?url=${encodeURIComponent(data.url)}&page=${source.page}${highlightParam}`,
          "_blank",
          "noopener,noreferrer",
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
    <div className='flex h-screen bg-[#0F0F0F] overflow-hidden'>
      {/* ------------------------------------------------------------------ */}
      {/* Sidebar */}
      {/* ------------------------------------------------------------------ */}
      <div className='w-64 shrink-0 bg-[#141414] border-r border-[#2B2B2B] flex flex-col'>
        {/* Logo */}
        <div className='px-4 pt-5 pb-4 flex justify-center'>
          <Image
            src='/AC_LogoName_Gold_Primary.png'
            alt='Advisors Clique Collective'
            width={180}
            height={50}
            className='object-contain'
            priority
          />
        </div>

        {/* Sidebar header */}
        <div className='px-4 pb-4 border-b border-[#2B2B2B]'>
          <button
            onClick={() => setShowNewSessionModal(true)}
            className='w-full flex items-center justify-center gap-2 bg-gold-gradient text-black rounded-lg py-2 px-3 text-sm font-semibold hover:shadow-gold-glow transition-shadow'
          >
            <Plus className='w-4 h-4' />
            New Chat
          </button>
        </div>

        {/* Session list */}
        <div className='flex-1 overflow-y-auto py-2'>
          {loadingSessions ? (
            <div className='flex justify-center py-8'>
              <Loader2 className='w-5 h-5 animate-spin text-gray-500' />
            </div>
          ) : sessions.length === 0 ? (
            <p className='text-xs text-gray-500 text-center py-8 px-4'>
              No chats yet. Click "New Chat" to start.
            </p>
          ) : (
            sessions.map((session) => (
              <div
                key={session.id}
                onClick={() => selectSession(session)}
                className={`group relative flex items-start gap-2 px-3 py-2.5 mx-2 rounded-lg cursor-pointer transition-all ${
                  activeSession?.id === session.id
                    ? "bg-[#1F1F1F] border-l-[3px] border-l-gold shadow-gold-glow text-white"
                    : "border-l-[3px] border-l-transparent hover:bg-[#1F1F1F] text-gray-300"
                }`}
              >
                <MessageSquare className='w-4 h-4 mt-0.5 shrink-0 opacity-60' />
                <div className='flex-1 min-w-0'>
                  <p className='text-sm font-medium truncate'>{session.name}</p>
                  <div className='flex items-center gap-1.5 mt-0.5'>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                        session.mode === "agent"
                          ? "bg-emerald-500/15 text-emerald-400"
                          : session.mode === "learner"
                            ? "bg-gold/15 text-gold-light"
                            : "bg-[#2B2B2B] text-gray-400"
                      }`}
                    >
                      {session.mode}
                    </span>
                    <span className='text-xs text-gray-500'>
                      {formatRelativeTime(session.updated_at)}
                    </span>
                  </div>
                </div>
                {/* Delete button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteSession(session.id);
                  }}
                  disabled={deletingId === session.id}
                  className='opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-900/30 hover:text-red-400 transition-all shrink-0'
                  title='Delete chat'
                >
                  {deletingId === session.id ? (
                    <Loader2 className='w-3.5 h-3.5 animate-spin' />
                  ) : (
                    <Trash2 className='w-3.5 h-3.5' />
                  )}
                </button>
              </div>
            ))
          )}
        </div>

        {/* Sidebar footer: logout */}
        <div className='border-t border-[#2B2B2B] p-3'>
          <button
            onClick={handleLogout}
            className='w-full flex items-center gap-2 text-sm text-gray-400 hover:text-white px-2 py-1.5 rounded-lg hover:bg-[#1F1F1F] transition-colors'
          >
            <LogOut className='w-4 h-4' />
            Logout
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Main area */}
      {/* ------------------------------------------------------------------ */}
      <div className='flex-1 flex flex-col min-w-0'>
        {/* Header */}
        <div className='bg-[#1F1F1F] text-white border-b border-[#2B2B2B] px-6 py-4 flex justify-between items-center shrink-0'>
          <div className='flex items-center gap-4'>
            {isAdmin && (
              <Link
                href='/admin/dashboard'
                className='flex items-center gap-1.5 text-sm text-gray-400 hover:text-gold transition-colors'
              >
                <ArrowLeft className='w-4 h-4' />
                Back to Dashboard
              </Link>
            )}
          </div>
          <div className='flex items-center gap-3'>
            <h1 className='text-lg font-semibold font-heading'>
              {activeSession ? activeSession.name : "AI Assistant"}
            </h1>
            {activeSession && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  activeSession.mode === "agent"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : activeSession.mode === "learner"
                      ? "bg-gold/15 text-gold-light"
                      : "bg-[#2B2B2B] text-gray-400"
                }`}
              >
                {activeSession.mode === "agent"
                  ? "Agent Mode"
                  : activeSession.mode === "learner"
                    ? "Learner Mode"
                    : "Client Mode"}
              </span>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className='flex-1 overflow-y-auto py-6'>
          <div className='max-w-3xl mx-auto px-6 space-y-6'>
            {!activeSession ? (
              <div className='flex flex-col items-center justify-center py-24 text-gray-500'>
                <MessageSquare className='w-16 h-16 mb-4' />
                <p className='text-lg font-medium mb-1'>No chat selected</p>
                <p className='text-sm'>
                  Create a new chat from the sidebar to get started.
                </p>
              </div>
            ) : loadingHistory ? (
              <div className='flex justify-center items-center py-20'>
                <Loader2 className='w-8 h-8 animate-spin text-gray-500' />
              </div>
            ) : messages.length === 0 ? (
              <div className='flex flex-col items-center justify-center py-20 text-gray-500'>
                <FileText className='w-16 h-16 mb-4' />
                <p>Ask a question to start the conversation</p>
              </div>
            ) : (
              messages.map((message) => (
                <div key={message.id} className='space-y-4'>
                  {/* User query */}
                  <div className='flex justify-end'>
                    <div className='bg-gold text-[#0A0A0A] rounded-2xl px-4 py-3 max-w-[75%] text-sm leading-relaxed font-medium'>
                      {message.query}
                    </div>
                  </div>

                  {/* Bot response */}
                  <div className='flex justify-start'>
                    <div className='bg-[#1F1F1F] border border-[#2B2B2B] rounded-2xl px-5 py-4 max-w-[85%] text-sm text-gray-200'>
                      <div className='prose prose-sm max-w-none prose-li:my-0.5 prose-headings:mb-2 prose-p:text-gray-200 prose-strong:text-white prose-li:text-gray-200 prose-headings:text-white prose-a:text-gold-light'>
                        <ReactMarkdown
                          urlTransform={(url) => {
                            if (
                              url.startsWith("cite:") ||
                              url.startsWith("cite-nolink:")
                            )
                              return url;
                            return defaultUrlTransform(url);
                          }}
                          components={{
                            p: ({ children }) => {
                              const arr = Array.isArray(children)
                                ? children
                                : [children];
                              const first = arr[0];
                              const isHeader =
                                isValidElement(first) &&
                                (first as React.ReactElement).type === "strong";
                              return (
                                <p
                                  className={
                                    isHeader
                                      ? "mt-5 mb-2"
                                      : "my-3 leading-relaxed"
                                  }
                                >
                                  {children}
                                </p>
                              );
                            },
                            a: ({ href, children }) => {
                              if (href?.startsWith("cite:")) {
                                const [docId, pageStr] = href
                                  .slice(5)
                                  .split(":");
                                const page = parseInt(pageStr, 10);
                                const matchedSource = message.sources.find(
                                  (s) =>
                                    s.document_id === docId && s.page === page,
                                );
                                return (
                                  <button
                                    onClick={(e) => {
                                      e.preventDefault();
                                      openDocumentPage({
                                        document_id: docId,
                                        page,
                                        text: matchedSource?.text,
                                      });
                                    }}
                                    className='inline-flex items-center gap-0.5 bg-gold/10 border border-gold/30 rounded px-1.5 py-0.5 text-xs text-gold-light hover:bg-gold/20 font-medium mx-0.5 align-middle not-prose transition-colors'
                                  >
                                    <FileText className='w-3 h-3' />
                                    {children}
                                  </button>
                                );
                              }
                              return (
                                <a
                                  href={href}
                                  target='_blank'
                                  rel='noopener noreferrer'
                                >
                                  {children}
                                </a>
                              );
                            },
                          }}
                        >
                          {preserveLineBreaks(
                            processCitations(message.response, message.sources),
                          )}
                        </ReactMarkdown>
                      </div>

                      {/* Sources */}
                      {message.sources && message.sources.length > 0 && (
                        <div className='mt-4 pt-3 border-t border-[#2B2B2B]'>
                          <p className='text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2'>
                            Sources
                          </p>
                          <div className='flex flex-wrap gap-2'>
                            {message.sources.map((source, idx) => (
                              <button
                                key={idx}
                                onClick={() => openDocumentPage(source)}
                                disabled={!source.document_id}
                                className='inline-flex items-center gap-1.5 bg-[#2B2B2B] border border-[#3a3a3a] rounded-md px-2.5 py-1 text-xs text-gray-300 hover:bg-[#333] hover:border-gold/30 disabled:cursor-default disabled:hover:bg-[#2B2B2B] disabled:hover:border-[#3a3a3a] transition-colors'
                              >
                                <FileText className='w-3 h-3 shrink-0 text-gray-500' />
                                {source.ref != null && (
                                  <span className='text-gold font-semibold'>
                                    [{source.ref}]
                                  </span>
                                )}
                                <span className='font-medium'>
                                  {source.filename}
                                </span>
                                <span className='text-gray-500'>
                                  · p.{source.page}
                                </span>
                                {source.document_id && (
                                  <ExternalLink className='w-3 h-3 shrink-0 text-gray-500' />
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Agent metadata: stop reason, iterations, cost */}
                      {message.stop_reason && (
                        <div className='mt-3 pt-2 border-t border-[#2B2B2B] flex flex-wrap items-center gap-3 text-xs text-gray-500'>
                          <span
                            className={`px-1.5 py-0.5 rounded font-medium ${
                              message.stop_reason === "completed"
                                ? "bg-emerald-500/10 text-emerald-400"
                                : "bg-amber-500/10 text-amber-400"
                            }`}
                          >
                            {message.stop_reason === "completed"
                              ? "Completed"
                              : message.stop_reason === "max_iterations"
                                ? "Hit iteration limit"
                                : message.stop_reason === "timeout"
                                  ? "Timed out"
                                  : "Empty response"}
                          </span>
                          {message.iterations != null && (
                            <span>{message.iterations} iteration{message.iterations !== 1 ? "s" : ""}</span>
                          )}
                          {message.total_tokens != null && (
                            <span>{message.total_tokens.toLocaleString()} tokens</span>
                          )}
                          {message.cost_usd != null && (
                            <span>${message.cost_usd.toFixed(4)}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}

            {loading && (
              <div className='flex justify-start'>
                <div className='bg-[#1F1F1F] border border-[#2B2B2B] rounded-2xl px-5 py-4 flex items-center gap-2.5'>
                  <Loader2 className='w-4 h-4 animate-spin text-gold shrink-0' />
                  {streamStatus && (
                    <span className='text-xs text-gray-400 animate-pulse'>
                      {streamStatus}
                    </span>
                  )}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input */}
        <div className='bg-[#141414] border-t border-[#2B2B2B] p-4 shrink-0'>
          <form onSubmit={sendMessage} className='max-w-3xl mx-auto flex gap-3'>
            <input
              type='text'
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                activeSession
                  ? "Ask a question..."
                  : "Select or create a chat to begin"
              }
              disabled={loading || !activeSession}
              className='flex-1 px-4 py-2.5 bg-[#1F1F1F] border border-[#2B2B2B] text-white placeholder-gray-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-gold focus:border-gold disabled:opacity-50'
            />
            <button
              type='submit'
              disabled={loading || !input.trim() || !activeSession}
              className='bg-gold-gradient text-black px-6 py-2.5 rounded-lg hover:shadow-gold-glow disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 font-semibold transition-shadow'
            >
              <Send className='w-4 h-4' />
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
