import { Icon, type IconData } from "@starterkit/ui/ui/icon";
import { ActivityIcon, AlertsIcon, BranchIcon, CalendarIcon, DiskIcon, ExternalLinkIcon, FileIcon, FolderIcon, NetworkIcon, IdentityIcon, KeyIcon, LogIcon, OverviewIcon, ReportsIcon, SecureIcon, SessionsIcon, SuccessIcon, SurfacesIcon, UploadIcon, UsersIcon } from "@starterkit/ui/ui/icons";
import type { NavIcon } from "@/lib/shared/nav";

const MAP = {
  dashboard: OverviewIcon, users: UsersIcon, roles: KeyIcon, permissions: SecureIcon, activity: LogIcon, signin: SessionsIcon,
  ds: SurfacesIcon, profile: IdentityIcon, projects: FolderIcon, members: UsersIcon,
  today: CalendarIcon, breaks: AlertsIcon, approvals: SuccessIcon, recons: NetworkIcon, sources: DiskIcon, workflows: BranchIcon, integrations: ExternalLinkIcon, posting: LogIcon, results: ReportsIcon, inbox: FolderIcon, reports: FileIcon,
  monitoring: ActivityIcon, feeds: UploadIcon,
} as const satisfies Record<NavIcon, IconData>;

/** 16 px stroke-1.5 nav icon; nothing for a nav child without one. */
export function NavGlyph({ icon, className }: { icon?: NavIcon; className?: string }) {
  return icon ? <Icon icon={MAP[icon]} className={className ?? "size-4"} /> : null;
}
