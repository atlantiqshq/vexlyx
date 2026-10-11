import type { SystemEmailEvent } from "@vexlyx/shared";
import type { SystemEmailService } from "./service.js";
import type { EmailParams } from "./templates.js";

// ---------------------------------------------------------------------------
// Module-level singleton so any feature service can send a notification with
// one line, without threading a mailer through every constructor. Mirrors
// cleanup/scheduler.ts. Until the API registers the service at startup (and
// in every unit test) these calls are silent no-ops.
// ---------------------------------------------------------------------------

let service: SystemEmailService | null = null;

export function registerSystemEmail(instance: SystemEmailService): void {
  service = instance;
}

export function notifyUser<E extends SystemEmailEvent>(event: E, to: string, params: EmailParams[E]): void {
  void service?.notify(event, to, params);
}

export function notifyAdmins<E extends SystemEmailEvent>(event: E, params: EmailParams[E]): void {
  void service?.notifyAdmins(event, params);
}
