"use client";

import { useState, useEffect, useRef, isValidElement } from "react";
import { createClient } from "@/lib/supabase/client";
import { Send, FileText, Loader2, LogOut, LayoutDashboard, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { api, SessionExpiredError } from "@/lib/api";

interface Message {
  id: string;
  query: string;
  response: string;
  sources: Array<{ filename: string; page: number; similarity: number; document_id?: string }>;
  created_at: string;
}

function processCitations(
  response: string,
  sources: Array<{ page: number; document_id?: string }>,
): string {
  const pageToDocId: Record<number, string> = {};
  for (const s of sources) {
    if (s.document_id && !pageToDocId[s.page]) {
      pageToDocId[s.page] = s.document_id;
    }
  }
  return response.replace(/\[p\.(\d+)\]/g, (_match, pageStr) => {
    const page = parseInt(pageStr, 10);
    const docId = pageToDocId[page];
    // Always produce a link — clickable if we have a docId, styled-only otherwise
    return docId
      ? `[p.${page}](cite:${docId}:${page})`
      : `[p.${page}](cite-nolink:${page})`;
  });
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const supabase = createClient();
  const router = useRouter();

  useEffect(() => {
    checkIfAdmin();
    loadChatHistory();
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

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
    } catch (error) {
      console.error("Failed to check admin status:", error);
    }
  };

  const loadChatHistory = async () => {
    try {
      const data = await api.get<{ messages: Message[] }>("/api/chat/history?limit=50");
      setMessages(data.messages.reverse());
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        router.push("/login");
        return;
      }
      console.error("Failed to load chat history:", error);
    } finally {
      setLoadingHistory(false);
    }
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const queryText = input.trim();
    setInput("");
    setLoading(true);

    try {
      const data = await api.post<{
        answer: string;
        sources: Message["sources"];
        chat_saved?: boolean;
      }>("/api/chat/message", { query: queryText });

      if (data.chat_saved === false) {
        console.error("Chat message was generated but failed to persist in Supabase");
      }

      const newMessage: Message = {
        id: Date.now().toString(),
        query: queryText,
        response: data.answer,
        sources: data.sources || [],
        created_at: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, newMessage]);
    } catch (error: any) {
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

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  const openDocumentPage = async (source: { document_id?: string; page: number }) => {
    if (!source.document_id) return;
    try {
      const data = await api.get<{ url: string }>(
        `/api/chat/document-url/${source.document_id}`
      );
      if (data.url) {
        const viewerUrl = `/view-document?url=${encodeURIComponent(data.url)}&page=${source.page}`;
        window.open(viewerUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (error) {
      console.error("Failed to open document:", error);
    }
  };

  return (
    <div className='flex flex-col h-screen bg-gray-50'>
      {/* Header */}
      <div className='bg-white border-b px-6 py-4 flex justify-between items-center'>
        <div className='flex items-center gap-4'>
          <h1 className='text-xl font-semibold'>AI Assistant</h1>
          {isAdmin && (
            <Link
              href='/admin/dashboard'
              className='flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900'
            >
              <LayoutDashboard className='w-4 h-4' />
              Back to Dashboard
            </Link>
          )}
        </div>
        <button
          onClick={handleLogout}
          className='flex items-center gap-2 text-gray-600 hover:text-gray-900'
        >
          <LogOut className='w-4 h-4' />
          Logout
        </button>
      </div>

      {/* Messages */}
      <div className='flex-1 overflow-y-auto py-6'>
        <div className='max-w-3xl mx-auto px-6 space-y-6'>
          {loadingHistory ? (
            <div className='flex justify-center items-center py-20'>
              <Loader2 className='w-8 h-8 animate-spin text-gray-400' />
            </div>
          ) : messages.length === 0 ? (
            <div className='flex flex-col items-center justify-center py-20 text-gray-400'>
              <FileText className='w-16 h-16 mb-4' />
              <p>Start a conversation by asking a question</p>
            </div>
          ) : (
            messages.map((message) => (
              <div key={message.id} className='space-y-4'>
                {/* User Query */}
                <div className='flex justify-end'>
                  <div className='bg-primary text-primary-foreground rounded-2xl px-4 py-3 max-w-[75%] text-sm leading-relaxed'>
                    {message.query}
                  </div>
                </div>

                {/* Bot Response */}
                <div className='flex justify-start'>
                  <div className='bg-white rounded-2xl px-5 py-4 max-w-[85%] shadow-sm text-sm text-gray-800'>
                    <div className='prose prose-sm max-w-none prose-li:my-0.5 prose-headings:mb-2'>
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
                              isValidElement(first) && (first as React.ReactElement).type === 'strong';
                            return (
                              <p className={isHeader ? 'mt-4 mb-1' : 'my-1'}>{children}</p>
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
                                  className='inline-flex items-center gap-0.5 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5 text-xs text-blue-600 hover:bg-blue-100 font-medium mx-0.5 align-middle not-prose'
                                >
                                  <FileText className='w-3 h-3' />
                                  {children}
                                </button>
                              );
                            }
                            if (href?.startsWith("cite-nolink:")) {
                              return (
                                <span className='inline-flex items-center gap-0.5 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5 text-xs text-blue-600 font-medium mx-0.5 align-middle not-prose'>
                                  <FileText className='w-3 h-3' />
                                  {children}
                                </span>
                              );
                            }
                            return (
                              <a href={href} target='_blank' rel='noopener noreferrer'>
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
                      <div className='mt-4 pt-3 border-t border-gray-100'>
                        <p className='text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2'>
                          Sources
                        </p>
                        <div className='flex flex-wrap gap-2'>
                          {message.sources.map((source, idx) => (
                            <button
                              key={idx}
                              onClick={() => openDocumentPage(source)}
                              disabled={!source.document_id}
                              className='inline-flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-md px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100 hover:border-gray-300 disabled:cursor-default disabled:hover:bg-gray-50 disabled:hover:border-gray-200 transition-colors'
                            >
                              <FileText className='w-3 h-3 shrink-0 text-gray-400' />
                              <span className='font-medium'>{source.filename}</span>
                              <span className='text-gray-400'>· p.{source.page}</span>
                              {source.document_id && (
                                <ExternalLink className='w-3 h-3 shrink-0 text-gray-400' />
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
            <div className='flex justify-start'>
              <div className='bg-white rounded-2xl px-5 py-4 shadow-sm'>
                <Loader2 className='w-5 h-5 animate-spin text-gray-400' />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className='bg-white border-t p-4'>
        <form onSubmit={sendMessage} className='max-w-3xl mx-auto flex gap-3'>
          <input
            type='text'
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder='Ask a question...'
            disabled={loading}
            className='flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50'
          />
          <button
            type='submit'
            disabled={loading || !input.trim()}
            className='bg-primary text-primary-foreground px-6 py-2 rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2'
          >
            <Send className='w-4 h-4' />
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
