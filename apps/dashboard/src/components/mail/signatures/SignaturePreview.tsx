"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { previewDocument } from "@/lib/signaturePreview";
import { cn } from "@/lib/utils";

type View = "light" | "dark" | "text";

const VIEWS: Array<{ id: View; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "text", label: "Plain text" },
];

interface SignaturePreviewProps {
  html: string | null;
  text: string | null;
  emptyMessage?: string;
  className?: string;
}

/**
 * Shows a signature the way a mail client would, in a frame with scripts and navigation switched off.
 * The HTML always comes from the shared renderer, which escapes everything it is given.
 */
export function SignaturePreview({ html, text, emptyMessage = "No signature will be added.", className }: SignaturePreviewProps) {
  const [view, setView] = useState<View>("light");

  if (!html) {
    return (
      <div className={cn("rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground", className)}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex gap-1" role="group" aria-label="Preview style">
        {VIEWS.map((option) => (
          <Button
            key={option.id}
            type="button"
            size="sm"
            variant={view === option.id ? "secondary" : "ghost"}
            className="h-7 px-2 text-xs"
            aria-pressed={view === option.id}
            onClick={() => setView(option.id)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {view === "text" ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs">
          {text}
        </pre>
      ) : (
        <iframe
          title="Signature preview"
          sandbox=""
          srcDoc={previewDocument(html, view === "dark")}
          className="h-48 w-full rounded-lg border border-border"
        />
      )}
    </div>
  );
}
