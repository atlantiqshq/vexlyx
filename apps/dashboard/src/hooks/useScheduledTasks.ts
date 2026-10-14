"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError, fetchAPI } from "@/lib/api";
import type {
  CreateScheduledTaskInput,
  SchedulePreviewResponse,
  ScheduledTaskListResponse,
  ScheduledTaskResponse,
  ScheduledTaskRunResponse,
  UpdateScheduledTaskInput,
} from "@vexlyx/shared";

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const base = (projectId: string) => `/api/projects/${projectId}/scheduled-tasks`;

/** Thin wrappers over the scheduled task endpoints. */
export const scheduledTaskApi = {
  list: (projectId: string) => fetchAPI<ScheduledTaskListResponse>(base(projectId)),
  create: (projectId: string, body: CreateScheduledTaskInput) => fetchAPI<ScheduledTaskResponse>(base(projectId), json("POST", body)),
  update: (projectId: string, taskId: string, body: UpdateScheduledTaskInput) =>
    fetchAPI<ScheduledTaskResponse>(`${base(projectId)}/${taskId}`, json("PUT", body)),
  remove: (projectId: string, taskId: string) => fetchAPI<void>(`${base(projectId)}/${taskId}`, json("DELETE")),
  runNow: (projectId: string, taskId: string) => fetchAPI<{ queued: true }>(`${base(projectId)}/${taskId}/run`, json("POST")),
  runs: (projectId: string, taskId: string, limit = 50) =>
    fetchAPI<{ runs: ScheduledTaskRunResponse[] }>(`${base(projectId)}/${taskId}/runs?limit=${limit}`),
  preview: (projectId: string, schedule: string) => fetchAPI<SchedulePreviewResponse>(`${base(projectId)}/preview`, json("POST", { schedule })),
};

export function taskErrorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

/** While a run is in progress the list is re-read every few seconds so its status updates by itself. */
const ACTIVE_POLL_MS = 3000;

export function useScheduledTasks(projectId: string) {
  const queryClient = useQueryClient();
  const queryKey = ["scheduled-tasks", projectId];

  const query = useQuery({
    queryKey,
    queryFn: () => scheduledTaskApi.list(projectId),
    refetchInterval: (state) => (state.state.data?.tasks.some((task) => task.lastStatus === "RUNNING") ? ACTIVE_POLL_MS : false),
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch: () => query.refetch(),
    /** Re-reads the list now, e.g. right after "Run now" so the new run appears quickly. */
    invalidate: () => queryClient.invalidateQueries({ queryKey }),
  };
}

export function useScheduledTaskRuns(projectId: string, taskId: string | null) {
  const query = useQuery({
    queryKey: ["scheduled-task-runs", projectId, taskId],
    queryFn: () => scheduledTaskApi.runs(projectId, taskId as string),
    enabled: taskId !== null,
    refetchInterval: (state) => (state.state.data?.runs.some((run) => run.status === "RUNNING") ? ACTIVE_POLL_MS : false),
  });
  return { runs: query.data?.runs, isLoading: query.isLoading, refetch: () => query.refetch() };
}
