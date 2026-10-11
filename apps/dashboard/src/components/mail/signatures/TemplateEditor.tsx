"use client";

import { useRef } from "react";
import { SIGNATURE_VARIABLES } from "@vexlyx/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface TemplateEditorProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  /** Variable buttons are hidden for text that doesn't use them. */
  showVariables?: boolean;
}

/** A plain-text box for signature templates, with buttons that insert variables where the cursor is. */
export function TemplateEditor({
  id,
  label,
  value,
  onChange,
  maxLength,
  rows = 6,
  placeholder,
  disabled,
  showVariables = true,
}: TemplateEditorProps) {
  const box = useRef<HTMLTextAreaElement>(null);

  const insert = (snippet: string) => {
    const element = box.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + snippet + value.slice(end));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-xs text-muted-foreground">
          {value.length} / {maxLength}
        </span>
      </div>
      <Textarea
        id={id}
        ref={box}
        value={value}
        rows={rows}
        maxLength={maxLength}
        disabled={disabled}
        placeholder={placeholder}
        className="font-mono text-xs"
        onChange={(event) => onChange(event.target.value)}
      />
      {showVariables && !disabled && (
        <div className="flex flex-wrap gap-1" aria-label="Insert a variable">
          {SIGNATURE_VARIABLES.map((variable) => (
            <Button
              key={variable}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 font-mono text-[11px]"
              onClick={() => insert(`{{${variable}}}`)}
            >
              {`{{${variable}}}`}
            </Button>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Plain text. Use <code>**bold**</code> and <code>[label](https://example.com)</code> (links must be https, mailto or
        tel). A line whose variables are all empty is left out.
      </p>
    </div>
  );
}
