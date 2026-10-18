"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiRequestError } from "@/lib/api";
import { fetchAPI } from "@/lib/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GitHubRepoPicker, type GitHubRepoSelection } from "./GitHubRepoPicker";
import type { CreateProjectInput, Project, ProjectType } from "@vexlyx/shared";

// ---------------------------------------------------------------------------
// Project type options shown in the select dropdown
// ---------------------------------------------------------------------------

const PROJECT_TYPE_OPTIONS: { value: ProjectType; label: string }[] = [
  { value: "NODEJS", label: "Node.js" },
  { value: "NEXTJS", label: "Next.js" },
  { value: "PYTHON", label: "Python" },
  { value: "REACT", label: "React" },
  { value: "STATIC", label: "Static Site" },
  { value: "PHP", label: "PHP" },
  { value: "WORDPRESS", label: "WordPress" },
  { value: "DOCKER", label: "Docker" },
];

// ---------------------------------------------------------------------------
// Form state + validation errors
// ---------------------------------------------------------------------------

interface FormState {
  name: string;
  type: ProjectType | "";
  gitUrl: string;
}

interface FormErrors {
  name?: string;
  type?: string;
  gitUrl?: string;
}

function validateForm(state: FormState): FormErrors {
  const errors: FormErrors = {};

  if (!state.name.trim()) {
    errors.name = "Project name is required";
  } else if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(state.name)) {
    errors.name = "Lowercase letters, numbers, and hyphens only (e.g. my-app)";
  } else if (state.name.length > 60) {
    errors.name = "Must be 60 characters or fewer";
  }

  if (!state.type) {
    errors.type = "Select a project type";
  }

  if (state.gitUrl && !/^https?:\/\/.+/.test(state.gitUrl)) {
    errors.gitUrl = "Must be a valid URL (https://...)";
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CreateProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: CreateProjectInput) => Promise<Project>;
}

export function CreateProjectModal({
  open,
  onOpenChange,
  onSubmit,
}: CreateProjectModalProps) {
  const [form, setForm] = useState<FormState>({ name: "", type: "", gitUrl: "" });
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sourceMode, setSourceMode] = useState<"github" | "manual">("github");
  const [githubSelection, setGitHubSelection] = useState<GitHubRepoSelection | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (!isSubmitting) {
      onOpenChange(next);
      if (!next) {
        setForm({ name: "", type: "", gitUrl: "" });
        setErrors({});
        setSourceMode("github");
        setGitHubSelection(null);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const validation = validateForm(form);
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      return;
    }

    setIsSubmitting(true);
    try {
      if (sourceMode === "github" && !githubSelection) {
        toast.error("Select a GitHub repository and branch");
        return;
      }
      const project = await onSubmit({
        name: form.name.trim(),
        type: form.type as ProjectType,
        gitUrl: sourceMode === "manual" ? form.gitUrl.trim() || undefined : undefined,
        branch: sourceMode === "github" ? githubSelection?.branch ?? "main" : "main",
      });
      if (sourceMode === "github" && githubSelection) {
        try {
          await fetchAPI(`/api/projects/${project.id}/git/connect-github`, {
            method: "POST",
            body: JSON.stringify({ installationId: githubSelection.installationId, repositoryId: githubSelection.repositoryId, branch: githubSelection.branch }),
          });
        } catch {
          toast.error("Project created, but GitHub cloning failed. Retry from the project's Git settings.");
          handleOpenChange(false);
          return;
        }
      }
      toast.success(`Project "${form.name}" created`);
      handleOpenChange(false);
    } catch (err) {
      const message =
        err instanceof ApiRequestError ? err.message : "Failed to create project";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
          <DialogDescription>
            Deploy an app from a Git repository or start with a template.
          </DialogDescription>
        </DialogHeader>

        <form id="create-project-form" onSubmit={handleSubmit} className="space-y-4 py-2">
          {/* Project name */}
          <div className="space-y-1.5">
            <Label htmlFor="project-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="project-name"
              placeholder="my-app"
              value={form.name}
              onChange={(e) => {
                setForm((prev) => ({ ...prev, name: e.target.value }));
                if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }));
              }}
              disabled={isSubmitting}
              autoComplete="off"
              autoFocus
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name}</p>
            )}
          </div>

          {/* Project type */}
          <div className="space-y-1.5">
            <Label htmlFor="project-type">
              Type <span className="text-destructive">*</span>
            </Label>
            <Select
              value={form.type}
              onValueChange={(value) => {
                setForm((prev) => ({ ...prev, type: value as ProjectType }));
                if (errors.type) setErrors((prev) => ({ ...prev, type: undefined }));
              }}
              disabled={isSubmitting}
            >
              <SelectTrigger id="project-type">
                <SelectValue placeholder="Select a framework..." />
              </SelectTrigger>
              <SelectContent>
                {PROJECT_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.type && (
              <p className="text-xs text-destructive">{errors.type}</p>
            )}
          </div>

          <Tabs value={sourceMode} onValueChange={(value) => setSourceMode(value as "github" | "manual")}>
            <TabsList className="grid w-full grid-cols-2"><TabsTrigger value="github">Import from GitHub</TabsTrigger><TabsTrigger value="manual">Manual Git URL</TabsTrigger></TabsList>
            <TabsContent value="github" className="pt-3"><GitHubRepoPicker value={githubSelection} onChange={setGitHubSelection} disabled={isSubmitting} /></TabsContent>
            <TabsContent value="manual" className="space-y-1.5 pt-3">
              <Label htmlFor="project-git-url">Git URL <span className="text-xs font-normal text-muted-foreground">optional</span></Label>
              <Input id="project-git-url" placeholder="https://github.com/user/repo" type="url" value={form.gitUrl} onChange={(e) => { setForm((prev) => ({ ...prev, gitUrl: e.target.value })); if (errors.gitUrl) setErrors((prev) => ({ ...prev, gitUrl: undefined })); }} disabled={isSubmitting} />
              {errors.gitUrl && <p className="text-xs text-destructive">{errors.gitUrl}</p>}
            </TabsContent>
          </Tabs>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            id="create-project-submit"
            type="submit"
            form="create-project-form"
            disabled={isSubmitting}
          >
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create Project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
