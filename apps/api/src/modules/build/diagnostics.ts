import { z } from "zod";

export const BuildFailureSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.object({
    file: z.string().optional(),
    remediation: z.string().optional(),
  }),
});

export const BUILD_FAILURE_PREFIX = "[vexlyx:failure] ";

export function readBuildFailure(logs: string | null) {
  const line = logs?.trimEnd().split("\n").at(-1);
  if (!line?.startsWith(BUILD_FAILURE_PREFIX)) return null;
  try {
    const parsed = BuildFailureSchema.safeParse(
      JSON.parse(line.slice(BUILD_FAILURE_PREFIX.length)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
