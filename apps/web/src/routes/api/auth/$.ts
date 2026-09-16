// Mounts the better-auth request handler at /api/auth/* (sign-in, OAuth
// callback, session, sign-out). The splat route forwards every method to
// better-auth, which owns routing within that namespace.
import { createFileRoute } from "@tanstack/react-router";
import { auth } from "../../../lib/auth";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
      POST: ({ request }) => auth.handler(request),
    },
  },
});
