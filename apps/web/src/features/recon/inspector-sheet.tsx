"use client";

import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";

/**
 * The inspector below 768 px (BUILDER-SPEC "Responsive"): a pass, a side or the settings in a bottom sheet (`Dialog`
 * is one below md). Loaded on first open through next/dynamic, so Radix's dialog stays out of the builder's first load.
 */
export default function InspectorSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">Changes apply to the draft; save the draft to keep them.</DialogDescription>
        </DialogHeader>
        <div className="px-6 py-5">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
