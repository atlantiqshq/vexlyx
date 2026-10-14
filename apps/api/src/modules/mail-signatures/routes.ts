import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import {
  DomainSignaturePolicySchema,
  SIGNATURE_LOGO_MAX_BYTES,
  SignatureBannerSchema,
  SignatureBulkSchema,
  SignatureExportSchema,
  SignatureGroupSchema,
  UpdateMailboxSignatureSchema,
} from "@vexlyx/shared";
import { AuditLogService } from "../audit-log/service.js";
import { MailSignatureService, SignatureError } from "./service.js";
import { SignatureSync } from "./sync.js";

const IdParam = z.object({ id: z.string().min(1) });
const ChildParam = z.object({ id: z.string().min(1), childId: z.string().min(1) });
const VersionParam = z.object({ id: z.string().min(1), versionId: z.string().min(1) });
const FileParam = z.object({ fileName: z.string().min(1).max(80) });
const EnforcementBody = z.object({ enabled: z.boolean() });

function handleError(err: unknown, reply: FastifyReply): void {
  if (err instanceof SignatureError) {
    reply.status(err.statusCode).send({ error: err.message, code: err.code, details: {} });
    return;
  }
  throw err;
}

/**
 * Mail signatures (F5.31). Registered under /api. Everything is owner-only like the
 * rest of the mail features, except the public logo route, which mail clients fetch
 * without a session.
 */
export async function mailSignatureRoutes(app: FastifyInstance) {
  const auditLog = new AuditLogService(app.prisma, app.log);
  const sync = new SignatureSync(app.prisma, app.log);
  const service = new MailSignatureService(app.prisma, auditLog, sync);
  const auth = { preHandler: [app.requireAuth] };

  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => request.userId ?? request.ip,
  });

  // ── Mailbox signature ────────────────────────────────────────────────

  app.get("/mailboxes/:id/signature", auth, async (request, reply) => {
    try {
      const { id } = IdParam.parse(request.params);
      return await service.getMailbox(request.userId!, id);
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.put("/mailboxes/:id/signature", auth, async (request, reply) => {
    try {
      const { id } = IdParam.parse(request.params);
      const body = UpdateMailboxSignatureSchema.parse(request.body);
      return await service.updateMailbox(request.userId!, id, body);
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.delete("/mailboxes/:id/signature", auth, async (request, reply) => {
    try {
      const { id } = IdParam.parse(request.params);
      return await service.resetMailbox(request.userId!, id);
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.get("/mailboxes/:id/signature/versions", auth, async (request, reply) => {
    try {
      const { id } = IdParam.parse(request.params);
      return { versions: await service.listMailboxVersions(request.userId!, id) };
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/mailboxes/:id/signature/versions/:versionId/restore", auth, async (request, reply) => {
    try {
      const { id, versionId } = VersionParam.parse(request.params);
      return await service.restoreMailboxVersion(request.userId!, id, versionId);
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post(
    "/mailboxes/:id/signature/test",
    { ...auth, config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      try {
        const { id } = IdParam.parse(request.params);
        return await service.sendTest(request.userId!, id);
      } catch (err) {
        handleError(err, reply);
      }
    },
  );

  // ── Domain signature ─────────────────────────────────────────────────

  app.get("/domains/:id/mail-signature", auth, async (request, reply) => {
    try {
      const { id } = IdParam.parse(request.params);
      return await service.getDomain(request.userId!, id);
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.put("/domains/:id/mail-signature", auth, async (request, reply) => {
    try {
      const { id } = IdParam.parse(request.params);
      const body = DomainSignaturePolicySchema.parse(request.body);
      return await service.updateDomain(request.userId!, id, body);
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.get("/domains/:id/mail-signature/versions", auth, async (request, reply) => {
    try {
      const { id } = IdParam.parse(request.params);
      return { versions: await service.listDomainVersions(request.userId!, id) };
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/domains/:id/mail-signature/versions/:versionId/restore", auth, async (request, reply) => {
    try {
      const { id, versionId } = VersionParam.parse(request.params);
      return await service.restoreDomainVersion(request.userId!, id, versionId);
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Groups ───────────────────────────────────────────────────────────

  app.post("/domains/:id/mail-signature/groups", auth, async (request, reply) => {
    try {
      const { id } = IdParam.parse(request.params);
      const result = await service.createGroup(request.userId!, id, SignatureGroupSchema.parse(request.body));
      reply.status(201);
      return result;
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.put("/domains/:id/mail-signature/groups/:childId", auth, async (request, reply) => {
    try {
      const { id, childId } = ChildParam.parse(request.params);
      return await service.updateGroup(request.userId!, id, childId, SignatureGroupSchema.parse(request.body));
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.delete("/domains/:id/mail-signature/groups/:childId", auth, async (request, reply) => {
    try {
      const { id, childId } = ChildParam.parse(request.params);
      return await service.deleteGroup(request.userId!, id, childId);
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Banners ──────────────────────────────────────────────────────────

  app.post("/domains/:id/mail-signature/banners", auth, async (request, reply) => {
    try {
      const { id } = IdParam.parse(request.params);
      const result = await service.createBanner(request.userId!, id, SignatureBannerSchema.parse(request.body));
      reply.status(201);
      return result;
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.put("/domains/:id/mail-signature/banners/:childId", auth, async (request, reply) => {
    try {
      const { id, childId } = ChildParam.parse(request.params);
      return await service.updateBanner(request.userId!, id, childId, SignatureBannerSchema.parse(request.body));
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.delete("/domains/:id/mail-signature/banners/:childId", auth, async (request, reply) => {
    try {
      const { id, childId } = ChildParam.parse(request.params);
      return await service.deleteBanner(request.userId!, id, childId);
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Bulk apply, export, import ───────────────────────────────────────

  app.post("/domains/:id/mail-signature/bulk", auth, async (request, reply) => {
    try {
      const { id } = IdParam.parse(request.params);
      return await service.bulk(request.userId!, id, SignatureBulkSchema.parse(request.body));
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.get("/domains/:id/mail-signature/export", auth, async (request, reply) => {
    try {
      const { id } = IdParam.parse(request.params);
      return await service.exportDomain(request.userId!, id);
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/domains/:id/mail-signature/import", auth, async (request, reply) => {
    try {
      const { id } = IdParam.parse(request.params);
      return await service.importDomain(request.userId!, id, SignatureExportSchema.parse(request.body));
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Logos ────────────────────────────────────────────────────────────

  app.post("/domains/:id/mail-signature/logo", auth, async (request, reply) => {
    try {
      const { id } = IdParam.parse(request.params);
      const part = await request.file({ limits: { fileSize: SIGNATURE_LOGO_MAX_BYTES, files: 1 } });
      if (!part) throw new SignatureError("Choose an image to upload", "NO_FILE", 400);

      let bytes: Buffer;
      try {
        bytes = await part.toBuffer();
      } catch (err) {
        if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
          throw new SignatureError(`Logos can be at most ${SIGNATURE_LOGO_MAX_BYTES / 1024} KB`, "LOGO_TOO_LARGE", 413);
        }
        throw err;
      }
      const result = await service.uploadLogo(request.userId!, id, bytes);
      reply.status(201);
      return result;
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.delete("/domains/:id/mail-signature/logo/:childId", auth, async (request, reply) => {
    try {
      const { id, childId } = ChildParam.parse(request.params);
      return await service.deleteLogo(request.userId!, id, childId);
    } catch (err) {
      handleError(err, reply);
    }
  });

  // Public: mail clients load the logo without a session. Only an exact, known
  // file name is served, always with its verified type and no way to run as a page.
  app.get("/signature-assets/:fileName", async (request, reply) => {
    const { fileName } = FileParam.parse(request.params);
    const asset = await service.findPublicAsset(fileName);
    if (!asset) {
      reply.status(404).send({ error: "Not found", code: "LOGO_NOT_FOUND", details: {} });
      return;
    }
    return reply
      .header("Content-Type", asset.contentType)
      .header("Content-Length", asset.size)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cross-Origin-Resource-Policy", "cross-origin")
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(createReadStream(asset.filePath));
  });

  // ── Global switch for server-side enforcement (admin) ────────────────

  app.get("/mail-signatures/enforcement", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    try {
      return await service.getEnforcement();
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.put("/mail-signatures/enforcement", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    try {
      const { enabled } = EnforcementBody.parse(request.body);
      return await service.setEnforcement(request.userId!, enabled);
    } catch (err) {
      handleError(err, reply);
    }
  });
}
