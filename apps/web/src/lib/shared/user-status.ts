import type { StatusTone } from "@starterkit/ui/lib/status";
import type { UserDto } from "@starterkit/shared/contracts/users";
import { statusTone } from "./categories";

/** One mapping for the status chip on every user screen: inactive = turned off on purpose (stopped). */
export function userStatus(u: UserDto): { health: StatusTone; label: "Active" | "Inactive" } {
  return u.isActive ? { health: statusTone("active"), label: "Active" } : { health: statusTone("inactive"), label: "Inactive" };
}
