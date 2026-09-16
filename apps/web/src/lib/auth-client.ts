// Browser-side better-auth client. baseURL defaults to the current origin, which
// is correct for both local dev and the deployed custom domain.
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export const { signIn, signOut, useSession } = authClient;
