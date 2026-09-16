import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { signIn } from "../lib/auth-client";
import { fetchAccessState } from "../lib/session";

export const Route = createFileRoute("/login")({
  // If already signed in — or if this deployment has no access gate at all —
  // skip the login screen. An open dashboard has no sign-in to offer.
  beforeLoad: async () => {
    const { restricted, session } = await fetchAccessState();
    if (!restricted || session) {
      throw redirect({
        to: "/",
        search: { segment: "global", byTheme: false, byProvider: false },
      });
    }
  },
  component: Login,
});

function Login() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <main className="auth">
      <div className="auth__card">
        <span className="auth__brand">aio</span>
        <h1 className="auth__title">Sign in</h1>
        <p className="auth__subtitle">Sign in with your Google account.</p>
        <button
          type="button"
          className="auth__google"
          disabled={pending}
          onClick={async () => {
            setError(null);
            setPending(true);
            const result = await signIn.social({
              provider: "google",
              callbackURL: "/",
              errorCallbackURL: "/login",
            });
            if (result.error) {
              setError(result.error.message ?? "Sign-in failed.");
              setPending(false);
            }
          }}
        >
          {pending ? "Redirecting…" : "Continue with Google"}
        </button>
        {error ? <p className="auth__error">{error}</p> : null}
      </div>
    </main>
  );
}
