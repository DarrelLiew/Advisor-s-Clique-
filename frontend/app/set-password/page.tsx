"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function SetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  // On mount, Supabase client auto-detects the invite token from the URL hash
  // and exchanges it for a session.
  useEffect(() => {
    const handleSession = async () => {
      // Listen for the auth event triggered by the invite link token exchange
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange(async (event) => {
        if (event === "SIGNED_IN" || event === "PASSWORD_RECOVERY") {
          setChecking(false);
        }
      });

      // Also check if there's already a session (e.g. token already exchanged)
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session) {
        setChecking(false);
      } else {
        // Give it a moment for the hash fragment to be processed
        setTimeout(async () => {
          const {
            data: { session: retrySession },
          } = await supabase.auth.getSession();
          if (retrySession) {
            setChecking(false);
          } else {
            setChecking(false);
            setError(
              "Invalid or expired invitation link. Please ask your admin to resend the invite.",
            );
          }
        }, 2000);
      }

      return () => subscription.unsubscribe();
    };

    handleSession();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      });

      if (updateError) throw updateError;

      // Mark invitation as accepted via profile update
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        // Use service client for profile update — but since we're on client side,
        // we rely on RLS (user can update their own profile)
        await supabase
          .from("profiles")
          .update({ invitation_status: "accepted" })
          .eq("id", user.id);
      }

      setSuccess(true);

      // Redirect to appropriate page after a brief delay
      setTimeout(() => {
        const role = user?.user_metadata?.role;
        if (role === "admin") {
          router.push("/admin/dashboard");
        } else {
          router.push("/chat");
        }
      }, 2000);
    } catch (err: any) {
      setError(err.message || "Failed to set password. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (checking) {
    return (
      <div className='min-h-screen flex items-center justify-center bg-gray-50'>
        <div className='text-center'>
          <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4' />
          <p className='text-gray-600'>Verifying invitation...</p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className='min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4'>
        <div className='max-w-md w-full text-center'>
          <div className='bg-green-50 border border-green-200 rounded-lg p-8'>
            <svg
              className='w-12 h-12 text-green-500 mx-auto mb-4'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={2}
                d='M5 13l4 4L19 7'
              />
            </svg>
            <h2 className='text-xl font-semibold text-green-800 mb-2'>
              Password Set Successfully!
            </h2>
            <p className='text-green-700'>Redirecting you to the app...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className='min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8'>
      <div className='max-w-md w-full space-y-8'>
        <div>
          <h2 className='mt-6 text-center text-3xl font-extrabold text-gray-900'>
            Set Your Password
          </h2>
          <p className='mt-2 text-center text-sm text-gray-600'>
            Welcome to Advisors Clique! Create a password to access your
            account.
          </p>
        </div>

        <form className='mt-8 space-y-6' onSubmit={handleSubmit}>
          <div className='space-y-4'>
            <div>
              <label
                htmlFor='password'
                className='block text-sm font-medium text-gray-700 mb-1'
              >
                Password
              </label>
              <input
                id='password'
                type='password'
                required
                minLength={8}
                className='appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-primary focus:border-primary sm:text-sm'
                placeholder='At least 8 characters'
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading || !!error}
              />
            </div>

            <div>
              <label
                htmlFor='confirm-password'
                className='block text-sm font-medium text-gray-700 mb-1'
              >
                Confirm Password
              </label>
              <input
                id='confirm-password'
                type='password'
                required
                minLength={8}
                className='appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-primary focus:border-primary sm:text-sm'
                placeholder='Re-enter your password'
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={loading || !!error}
              />
            </div>
          </div>

          {error && (
            <div className='rounded-md bg-red-50 p-4'>
              <p className='text-sm text-red-800'>{error}</p>
            </div>
          )}

          <button
            type='submit'
            disabled={loading || !!error}
            className='group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-primary hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed'
          >
            {loading ? "Setting password..." : "Set Password & Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
