"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, SessionExpiredError } from "@/lib/api";

export default function UsersPage() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("user");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const router = useRouter();

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    try {
      const data = await api.post<{ magic_link: string }>("/api/admin/users/create", {
        email,
        role,
        send_magic_link: true,
      });

      setMessage({
        type: "success",
        text: `User created successfully! Magic link: ${data.magic_link}`,
      });
      setEmail("");
      setRole("user");
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
      setLoading(false);
    }
  };

  return (
    <div className='max-w-4xl mx-auto px-6 py-8'>
      <div className='mb-6'>
        <h2 className='text-2xl font-bold mb-2'>User Management</h2>
        <p className='text-gray-600'>Create new user accounts</p>
      </div>

      {/* Create User Form */}
      <div className='bg-white rounded-lg shadow-sm border p-6'>
        <h3 className='text-lg font-semibold mb-4'>Create New User</h3>

        <form onSubmit={handleCreateUser} className='space-y-4'>
          <div>
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
              disabled={loading}
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
              disabled={loading}
            >
              <option value='user'>User</option>
              <option value='admin'>Admin</option>
            </select>
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
            disabled={loading}
            className='w-full bg-primary text-primary-foreground py-2 rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed'
          >
            {loading ? "Creating..." : "Create User"}
          </button>
        </form>

        <div className='mt-6 p-4 bg-blue-50 rounded-lg border border-blue-200'>
          <p className='text-sm text-blue-800'>
            <strong>Note:</strong> A magic link will be generated for the user
            to set their password. Copy and send this link to the user via
            email.
          </p>
        </div>
      </div>
    </div>
  );
}
