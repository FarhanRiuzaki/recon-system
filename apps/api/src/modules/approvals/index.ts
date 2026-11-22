// Public API of the approvals module: its route. It owns no table yet: the requests it lists are the versions sent for
// approval, owned by the sources and recon modules (read through their index); break requests join with Breaks (Plan 5).
export { approvalsController } from "./controller";
