import type { StatusTone } from "@starterkit/ui/lib/status";
import type { UserDto } from "@starterkit/shared/contracts/users";
import { statusTone } from "./categories";

/** How a user signs in, as the form, the users list and the detail page name it. */
export const SIGN_IN_METHOD = "Sign-in method";
export const signInText = (isLdap: boolean) => (isLdap ? "Directory account" : "Password");

/** One mapping for the status chip on every user screen: inactive = turned off on purpose (stopped). */
export function userStatus(u: UserDto): { health: StatusTone; label: "Active" | "Inactive" } {
  return u.isActive ? { health: statusTone("active"), label: "Active" } : { health: statusTone("inactive"), label: "Inactive" };
}
