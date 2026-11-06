"use client";

import { Sheet } from "./Sheet.tsx";

/** A prize or pack item's details: a sheet on phones, a wide centered panel from 760 px. Back, Esc, the dim and the X all close it. */
export function DetailSheet({ label, onClose, children, className = "detail", top }: { label: string; onClose: () => void; children: React.ReactNode; className?: string; top?: boolean }) {
  return (
    <Sheet className={className} label={label} onClose={onClose} top={top} backCloses>
      {children}
    </Sheet>
  );
}
