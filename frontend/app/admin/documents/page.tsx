"use client";

import { useState, useEffect } from "react";
import {
  Upload,
  FileText,
  CheckCircle,
  XCircle,
  Clock,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { api, SessionExpiredError } from "@/lib/api";
import { useRouter } from "next/navigation";

interface Document {
  id: string;
  filename: string;
  processing_status: string;
  total_pages: number | null;
  uploaded_at: string;
  error_message: string | null;
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageMessage, setPageMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const router = useRouter();

  useEffect(() => {
    loadDocuments();
    // Poll for status updates
    const interval = setInterval(loadDocuments, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadDocuments = async () => {
    try {
      const data = await api.get<{ documents: Document[] }>("/api/admin/documents");
      setDocuments(data.documents || []);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        router.push("/login");
        return;
      }
      console.error("Failed to load documents:", error);
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== "application/pdf") {
      setPageMessage({ type: "error", text: "Please upload a PDF file." });
      return;
    }

    if (file.size > 100 * 1024 * 1024) {
      setPageMessage({ type: "error", text: "File size must be less than 100MB." });
      return;
    }

    setUploading(true);
    setPageMessage(null);
    e.target.value = ""; // Reset input immediately so same file can be re-selected

    try {
      // Convert to base64 using a Promise so we can await it
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result?.toString().split(",")[1];
          if (result) resolve(result);
          else reject(new Error("Failed to read file"));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });

      await api.post("/api/admin/documents/upload", {
        filename: file.name,
        file_data: base64,
        mime_type: file.type,
      });

      await loadDocuments();
      setPageMessage({
        type: "success",
        text: "Document uploaded! Processing has started — status will update automatically.",
      });
    } catch (error: any) {
      if (error instanceof SessionExpiredError) {
        router.push("/login");
        return;
      }
      console.error("Upload error:", error);
      setPageMessage({ type: "error", text: error.message || "Failed to upload document." });
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this document?")) return;

    try {
      await api.delete(`/api/admin/documents/${id}`);
      await loadDocuments();
    } catch (error: any) {
      if (error instanceof SessionExpiredError) {
        router.push("/login");
        return;
      }
      console.error("Delete error:", error);
      setPageMessage({ type: "error", text: "Failed to delete document." });
    }
  };

  const handleReprocess = async (id: string) => {
    if (!confirm("Re-process this document? Existing chunks will be deleted and re-embedded with the current chunk settings.")) return;

    try {
      await api.post(`/api/admin/documents/${id}/reprocess`, {});
      await loadDocuments();
      setPageMessage({ type: "success", text: "Reprocessing started — status will update automatically." });
    } catch (error: any) {
      if (error instanceof SessionExpiredError) {
        router.push("/login");
        return;
      }
      console.error("Reprocess error:", error);
      setPageMessage({ type: "error", text: error.message || "Failed to start reprocessing." });
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "ready":
        return <CheckCircle className='w-5 h-5 text-green-500' />;
      case "failed":
        return <XCircle className='w-5 h-5 text-red-500' />;
      case "processing":
      case "pending":
        return <Clock className='w-5 h-5 text-yellow-500 animate-pulse' />;
      default:
        return null;
    }
  };

  return (
    <div className='max-w-7xl mx-auto px-6 py-8'>
      <div className='mb-6'>
        <h2 className='text-2xl font-bold mb-2'>Documents</h2>
        <p className='text-gray-600'>
          Upload and manage PDF documents for the chatbot
        </p>
      </div>

      {/* Upload Section */}
      <div className='bg-white rounded-lg shadow-sm border p-6 mb-6'>
        <label className='flex flex-col items-center justify-center border-2 border-dashed border-gray-300 rounded-lg p-12 cursor-pointer hover:border-primary transition'>
          <Upload className='w-12 h-12 text-gray-400 mb-3' />
          <span className='text-gray-600'>
            {uploading ? "Uploading..." : "Click to upload PDF"}
          </span>
          <span className='text-sm text-gray-400 mt-1'>
            Maximum file size: 100MB
          </span>
          <input
            type='file'
            accept='application/pdf'
            onChange={handleFileUpload}
            disabled={uploading}
            className='hidden'
          />
        </label>

        {pageMessage && (
          <div
            className={`mt-4 p-3 rounded-lg text-sm ${
              pageMessage.type === "success"
                ? "bg-green-50 text-green-800 border border-green-200"
                : "bg-red-50 text-red-800 border border-red-200"
            }`}
          >
            {pageMessage.text}
          </div>
        )}
      </div>

      {/* Documents List */}
      <div className='bg-white rounded-lg shadow-sm border overflow-hidden'>
        {loading ? (
          <div className='p-12 text-center text-gray-500'>
            Loading documents...
          </div>
        ) : documents.length === 0 ? (
          <div className='p-12 text-center text-gray-500'>
            <FileText className='w-12 h-12 mx-auto mb-3 opacity-20' />
            <p>No documents uploaded yet</p>
          </div>
        ) : (
          <table className='w-full'>
            <thead className='bg-gray-50 border-b'>
              <tr>
                <th className='text-left px-6 py-3 text-sm font-medium text-gray-700'>
                  Filename
                </th>
                <th className='text-left px-6 py-3 text-sm font-medium text-gray-700'>
                  Status
                </th>
                <th className='text-left px-6 py-3 text-sm font-medium text-gray-700'>
                  Pages
                </th>
                <th className='text-left px-6 py-3 text-sm font-medium text-gray-700'>
                  Uploaded
                </th>
                <th className='text-right px-6 py-3 text-sm font-medium text-gray-700'>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className='divide-y'>
              {documents.map((doc) => (
                <tr key={doc.id} className='hover:bg-gray-50'>
                  <td className='px-6 py-4'>
                    <div className='flex items-center gap-2'>
                      <FileText className='w-4 h-4 text-gray-400' />
                      <span className='font-medium'>{doc.filename}</span>
                    </div>
                    {doc.error_message && (
                      <p className='text-xs text-red-600 mt-1'>
                        {doc.error_message}
                      </p>
                    )}
                  </td>
                  <td className='px-6 py-4'>
                    <div className='flex items-center gap-2'>
                      {getStatusIcon(doc.processing_status)}
                      <span className='text-sm capitalize'>
                        {doc.processing_status}
                      </span>
                    </div>
                  </td>
                  <td className='px-6 py-4 text-sm text-gray-600'>
                    {doc.total_pages || "-"}
                  </td>
                  <td className='px-6 py-4 text-sm text-gray-600'>
                    {new Date(doc.uploaded_at).toLocaleDateString()}
                  </td>
                  <td className='px-6 py-4 text-right'>
                    <div className='flex items-center justify-end gap-3'>
                      {doc.processing_status === 'ready' && (
                        <button
                          onClick={() => handleReprocess(doc.id)}
                          title='Re-process with current chunk settings'
                          className='text-gray-400 hover:text-blue-600'
                        >
                          <RefreshCw className='w-4 h-4' />
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(doc.id)}
                        className='text-red-600 hover:text-red-800'
                      >
                        <Trash2 className='w-4 h-4' />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
