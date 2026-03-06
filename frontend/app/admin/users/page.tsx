"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { api, SessionExpiredError } from "@/lib/api";
import { Loader2, RefreshCw, Mail, UserPlus } from "lucide-react";

interface User {
  id: string;
  email?: string;
  role: string;
  telegram_linked: boolean;
  invitation_status: string;
  invitation_sent_at: string | null;
  last_sign_in_at: string | null;
  created_at: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("user");
  const [creating, setCreating] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const router = useRouter();

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    setLoadingUsers(true);
    try {
      const data = await api.get<{ users: User[] }>("/api/admin/users");
      setUsers(data.users);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        router.push("/login");
        return;
      }
      console.error("Failed to load users:", error);
    } finally {
      setLoadingUsers(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setMessage(null);

    try {
      await api.post("/api/admin/users/create", { email, role });
      setMessage({
        type: "success",
        text: `Invitation email sent to ${email} successfully!`,
      });
      setEmail("");
      setRole("user");
      await loadUsers();
    } catch (error: any) {
      if (error instanceof SessionExpiredError) {
        router.push("/login");
        return;
      }
      console.error("Create user error:", error);
      setMessage({
        type: "error",
        text: error.message || "Failed to create user",
      });
    } finally {
      setCreating(false);
    }
  };

  const handleResendInvite = async (userId: string) => {
    setResendingId(userId);
    setMessage(null);
    try {
      await api.patch(`/api/admin/users/${userId}/resend-invite`, {});
      setMessage({
        type: "success",
        text: "Invitation email resent successfully!",
      });
      await loadUsers();
    } catch (error: any) {
      if (error instanceof SessionExpiredError) {
        router.push("/login");
        return;
      }
      setMessage({
        type: "error",
        text: error.message || "Failed to resend invitation",
      });
    } finally {
      setResendingId(null);
    }
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return "\u2014";
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className='max-w-5xl mx-auto px-6 py-8'>
      <div className='mb-6'>
        <h2 className='text-2xl font-bold mb-2'>User Management</h2>
        <p className='text-gray-600'>
          Invite new users and manage existing accounts
        </p>
      </div>

      {/* Create User Form */}
      <div className='bg-white rounded-lg shadow-sm border p-6 mb-8'>
        <h3 className='text-lg font-semibold mb-4 flex items-center gap-2'>
          <UserPlus className='w-5 h-5' />
          Invite New User
        </h3>

        <form onSubmit={handleCreateUser} className='space-y-4'>
          <div className='grid grid-cols-1 md:grid-cols-3 gap-4'>
            <div className='md:col-span-2'>
              <label
                htmlFor='email'
                className='block text-sm font-medium text-gray-700 mb-1'
              >
                Email Address
              </label>
              <input
                type='email'
                id='email'
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className='w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary'
                placeholder='user@example.com'
                disabled={creating}
              />
            </div>

            <div>
              <label
                htmlFor='role'
                className='block text-sm font-medium text-gray-700 mb-1'
              >
                Role
              </label>
              <select
                id='role'
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className='w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary'
                disabled={creating}
              >
                <option value='user'>User</option>
                <option value='admin'>Admin</option>
              </select>
            </div>
          </div>

          {message && (
            <div
              className={`p-4 rounded-lg ${
                message.type === "success"
                  ? "bg-green-50 text-green-800 border border-green-200"
                  : "bg-red-50 text-red-800 border border-red-200"
              }`}
            >
              <p className='text-sm'>{message.text}</p>
            </div>
          )}

          <button
            type='submit'
            disabled={creating}
            className='flex items-center gap-2 bg-primary text-primary-foreground py-2 px-4 rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed'
          >
            {creating ? (
              <Loader2 className='w-4 h-4 animate-spin' />
            ) : (
              <Mail className='w-4 h-4' />
            )}
            {creating ? "Sending Invite..." : "Send Invitation"}
          </button>
        </form>

        <div className='mt-4 p-3 bg-blue-50 rounded-lg border border-blue-200'>
          <p className='text-sm text-blue-800'>
            An invitation email will be sent directly to the user. They will
            click the link to set their password and access the app.
          </p>
        </div>
      </div>

      {/* Users List */}
      <div className='bg-white rounded-lg shadow-sm border'>
        <div className='px-6 py-4 border-b flex items-center justify-between'>
          <h3 className='text-lg font-semibold'>All Users</h3>
          <button
            onClick={loadUsers}
            disabled={loadingUsers}
            className='flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 px-2 py-1 rounded hover:bg-gray-100 transition-colors'
          >
            <RefreshCw
              className={`w-4 h-4 ${loadingUsers ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
        </div>

        {loadingUsers ? (
          <div className='flex justify-center py-12'>
            <Loader2 className='w-6 h-6 animate-spin text-gray-400' />
          </div>
        ) : users.length === 0 ? (
          <div className='text-center py-12 text-gray-500'>No users found.</div>
        ) : (
          <div className='overflow-x-auto'>
            <table className='w-full text-sm'>
              <thead>
                <tr className='bg-gray-50 border-b'>
                  <th className='text-left px-6 py-3 font-medium text-gray-600'>
                    Email
                  </th>
                  <th className='text-left px-4 py-3 font-medium text-gray-600'>
                    Role
                  </th>
                  <th className='text-left px-4 py-3 font-medium text-gray-600'>
                    Status
                  </th>
                  <th className='text-left px-4 py-3 font-medium text-gray-600'>
                    Invited
                  </th>
                  <th className='text-left px-4 py-3 font-medium text-gray-600'>
                    Last Sign In
                  </th>
                  <th className='text-right px-6 py-3 font-medium text-gray-600'>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className='divide-y'>
                {users.map((user) => (
                  <tr key={user.id} className='hover:bg-gray-50'>
                    <td className='px-6 py-3 font-medium'>
                      {user.email || "\u2014"}
                    </td>
                    <td className='px-4 py-3'>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          user.role === "admin"
                            ? "bg-purple-100 text-purple-700"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {user.role}
                      </span>
                    </td>
                    <td className='px-4 py-3'>
                      {user.invitation_status === "accepted" ? (
                        <span className='inline-flex items-center gap-1 text-green-700 bg-green-50 border border-green-200 rounded-full px-2.5 py-0.5 text-xs font-medium'>
                          <span className='w-1.5 h-1.5 rounded-full bg-green-500' />
                          Active
                        </span>
                      ) : (
                        <span className='inline-flex items-center gap-1 text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-0.5 text-xs font-medium'>
                          <span className='w-1.5 h-1.5 rounded-full bg-amber-500' />
                          Pending
                        </span>
                      )}
                    </td>
                    <td className='px-4 py-3 text-gray-500 text-xs'>
                      {formatDate(user.invitation_sent_at)}
                    </td>
                    <td className='px-4 py-3 text-gray-500 text-xs'>
                      {formatDate(user.last_sign_in_at)}
                    </td>
                    <td className='px-6 py-3 text-right'>
                      {user.invitation_status !== "accepted" && (
                        <button
                          onClick={() => handleResendInvite(user.id)}
                          disabled={resendingId === user.id}
                          className='inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded px-2.5 py-1 transition-colors disabled:opacity-50'
                        >
                          {resendingId === user.id ? (
                            <Loader2 className='w-3 h-3 animate-spin' />
                          ) : (
                            <Mail className='w-3 h-3' />
                          )}
                          Resend
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
