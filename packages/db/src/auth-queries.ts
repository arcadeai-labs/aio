// Typed auth-related queries. Keeping Drizzle usage inside @aio/db means callers
// (the web app's better-auth hooks) don't take a direct drizzle-orm dependency.
import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { user } from "./schema/auth.js";

export interface UserAccessFields {
  email: string;
  emailVerified: boolean;
}

/**
 * Fetch only the fields the access gate needs for a user, or `null` if the user
 * does not exist.
 */
export async function findUserAccessFields(
  userId: string,
): Promise<UserAccessFields | null> {
  const row = await db.query.user.findFirst({
    where: eq(user.id, userId),
    columns: { email: true, emailVerified: true },
  });
  return row ?? null;
}
