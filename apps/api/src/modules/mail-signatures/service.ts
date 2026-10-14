import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  DomainSignaturePolicySchema,
  SIGNATURE_EXPORT_FORMAT,
  SIGNATURE_LOGO_MAX_BYTES,
  SIGNATURE_VERSIONS_KEPT,
  SignatureBannerSchema,
  SignatureGroupSchema,
  UpdateMailboxSignatureSchema,
  type DomainSignatureResponse,
  type MailboxSignatureResponse,
  type SignatureBulkInput,
  type SignatureBulkResult,
  type SignatureEnforcementStatus,
  type SignatureExport,
  type SignatureVersionResponse,
} from "@vexlyx/shared";
import { env } from "../../config/env.js";
import type { AuditLogService } from "../audit-log/service.js";
import { notifyUser } from "../system-email/notifier.js";
import { ASSET_FILE_NAME, assetUrl, detectLogoType } from "./assets.js";
import { runSignatureManager } from "./manager.js";
import { composeAt, resolveSignature } from "./resolve.js";
import { SignatureSync, toDomainPolicy, toMailboxSettings } from "./sync.js";

export class SignatureError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "SignatureError";
  }
}

const MAX_GROUPS = 50;
const MAX_BANNERS = 50;
const MAX_ASSETS = 10;

export type MailboxUpdate = z.output<typeof UpdateMailboxSignatureSchema>;
type DomainPolicyInput = z.output<typeof DomainSignaturePolicySchema>;
type GroupInput = z.output<typeof SignatureGroupSchema>;
type BannerInput = z.output<typeof SignatureBannerSchema>;

const MailboxSnapshotSchema = z.object({
  mode: z.enum(["INHERIT", "CUSTOM", "NONE"]),
  template: z.string().nullable(),
  groupId: z.string().nullable(),
  displayName: z.string().nullable(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  phone: z.string().nullable(),
  mobile: z.string().nullable(),
});

const notFound = (what: "mailbox" | "domain" | "group" | "banner" | "version" | "logo") =>
  new SignatureError(`${what[0]!.toUpperCase()}${what.slice(1)} not found`, `${what.toUpperCase()}_NOT_FOUND`, 404);

export class MailSignatureService {
  constructor(
    private prisma: PrismaClient,
    private auditLog: AuditLogService,
    private sync: SignatureSync,
  ) {}

  // ── Mailbox ────────────────────────────────────────────────────────────

  async getMailbox(userId: string, mailboxId: string, syncWarning?: string | null): Promise<MailboxSignatureResponse> {
    const mailbox = await this.ownedMailbox(userId, mailboxId);
    const context = await this.domainContext(mailbox.domainId);
    const settings = toMailboxSettings(mailbox.signature);
    const resolution = resolveSignature({
      address: mailbox.address,
      domain: context.policy,
      mailbox: settings,
      group: context.groups.find((group) => group.id === settings.groupId) ?? null,
      banners: context.banners,
    });
    const composed = composeAt(resolution, new Date());

    return {
      mailboxId: mailbox.id,
      address: mailbox.address,
      mode: settings.mode,
      template: settings.template,
      groupId: settings.groupId,
      profile: {
        displayName: settings.displayName,
        title: settings.title,
        department: settings.department,
        phone: settings.phone,
        mobile: settings.mobile,
      },
      domainLocked: context.policy.locked,
      resolved: { source: resolution.source, html: composed?.html ?? null, text: composed?.text ?? null },
      ...(syncWarning ? { syncWarning } : {}),
    };
  }

  async updateMailbox(userId: string, mailboxId: string, input: MailboxUpdate): Promise<MailboxSignatureResponse> {
    const mailbox = await this.ownedMailbox(userId, mailboxId);
    const context = await this.domainContext(mailbox.domainId);

    if (context.policy.locked && input.mode !== "INHERIT") {
      throw new SignatureError(
        "This domain locks its signature, so a mailbox can't use its own or turn it off. Only the profile can be edited.",
        "DOMAIN_LOCKED",
        409,
      );
    }
    if (input.groupId && !context.groups.some((group) => group.id === input.groupId)) {
      throw new SignatureError("That group doesn't belong to this domain", "GROUP_NOT_FOUND", 400);
    }

    await this.recordVersion("MAILBOX", mailbox.id, this.mailboxSnapshot(mailbox.signature), userId);
    const data = {
      mode: input.mode,
      template: input.template ?? null,
      groupId: input.groupId ?? null,
      displayName: input.displayName,
      title: input.title,
      department: input.department,
      phone: input.phone,
      mobile: input.mobile,
    };
    await this.prisma.mailboxSignature.upsert({
      where: { mailboxId: mailbox.id },
      create: { mailboxId: mailbox.id, ...data },
      update: data,
    });

    await this.auditLog.log(userId, "mailbox.signature_updated", { type: "Mailbox", id: mailbox.id }, {
      after: { mode: input.mode, groupId: input.groupId ?? null },
    });
    return this.getMailbox(userId, mailboxId, await this.sync.syncMailbox(mailbox.id));
  }

  /** Back to the defaults: follow the domain, with an empty profile. */
  async resetMailbox(userId: string, mailboxId: string): Promise<MailboxSignatureResponse> {
    const mailbox = await this.ownedMailbox(userId, mailboxId);
    if (mailbox.signature) {
      await this.recordVersion("MAILBOX", mailbox.id, this.mailboxSnapshot(mailbox.signature), userId);
      await this.prisma.mailboxSignature.delete({ where: { mailboxId: mailbox.id } });
    }
    await this.auditLog.log(userId, "mailbox.signature_updated", { type: "Mailbox", id: mailbox.id }, {
      after: { reset: true },
    });
    return this.getMailbox(userId, mailboxId, await this.sync.syncMailbox(mailbox.id));
  }

  async listMailboxVersions(userId: string, mailboxId: string): Promise<SignatureVersionResponse[]> {
    const mailbox = await this.ownedMailbox(userId, mailboxId);
    return this.listVersions("MAILBOX", mailbox.id);
  }

  async restoreMailboxVersion(userId: string, mailboxId: string, versionId: string): Promise<MailboxSignatureResponse> {
    const mailbox = await this.ownedMailbox(userId, mailboxId);
    const version = await this.findVersion("MAILBOX", mailbox.id, versionId);
    const snapshot = MailboxSnapshotSchema.safeParse(version.snapshot);
    if (!snapshot.success) throw new SignatureError("That version can't be restored", "VERSION_INVALID", 422);

    const context = await this.domainContext(mailbox.domainId);
    const groupStillThere = snapshot.data.groupId !== null && context.groups.some((g) => g.id === snapshot.data.groupId);
    return this.updateMailbox(userId, mailboxId, {
      ...snapshot.data,
      groupId: groupStillThere ? snapshot.data.groupId : null,
    });
  }

  /** Emails the account owner a message showing the signature exactly as it would be sent. */
  async sendTest(userId: string, mailboxId: string): Promise<{ sentTo: string }> {
    const view = await this.getMailbox(userId, mailboxId);
    if (!view.resolved.html || !view.resolved.text) {
      throw new SignatureError("This mailbox has no signature to preview", "NO_SIGNATURE", 400);
    }
    const owner = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!owner) throw new SignatureError("User not found", "USER_NOT_FOUND", 404);

    notifyUser("signature_test", owner.email, {
      name: owner.name,
      address: view.address,
      signatureHtml: view.resolved.html,
      signatureText: view.resolved.text,
    });
    return { sentTo: owner.email };
  }

  // ── Domain ─────────────────────────────────────────────────────────────

  async getDomain(userId: string, domainId: string, syncWarning?: string | null): Promise<DomainSignatureResponse> {
    const domain = await this.ownedDomain(userId, domainId);
    const [groups, banners, assets, settings] = await Promise.all([
      this.prisma.signatureGroup.findMany({
        where: { domainId },
        orderBy: { name: "asc" },
        include: { _count: { select: { members: true } } },
      }),
      this.prisma.signatureBanner.findMany({ where: { domainId }, orderBy: { startsAt: "asc" } }),
      this.prisma.signatureAsset.findMany({ where: { domainId }, orderBy: { createdAt: "desc" } }),
      this.prisma.systemSettings.findUnique({ where: { id: "default" }, select: { signatureEnforcement: true } }),
    ]);
    const { hostname: _hostname, ...policy } = toDomainPolicy(domain.hostname, domain.mailSignature);

    return {
      domainId,
      hostname: domain.hostname,
      ...policy,
      groups: groups.map((g) => ({ id: g.id, name: g.name, template: g.template, members: g._count.members })),
      banners: banners.map((b) => ({
        id: b.id,
        groupId: b.groupId,
        text: b.text,
        startsAt: b.startsAt.toISOString(),
        endsAt: b.endsAt.toISOString(),
        enabled: b.enabled,
      })),
      assets: assets.map((a) => ({ id: a.id, url: assetUrl(a.fileName), size: a.size, createdAt: a.createdAt.toISOString() })),
      enforcementAvailable: settings?.signatureEnforcement ?? true,
      ...(syncWarning ? { syncWarning } : {}),
    };
  }

  async updateDomain(userId: string, domainId: string, input: DomainPolicyInput): Promise<DomainSignatureResponse> {
    const domain = await this.ownedDomain(userId, domainId);
    const suffix = `@${domain.hostname.toLowerCase()}`;
    const stranger = input.senderList.find((address) => !address.endsWith(suffix));
    if (stranger) {
      throw new SignatureError(`${stranger} isn't a mailbox of ${domain.hostname}`, "INVALID_SENDER", 400);
    }

    await this.recordVersion("DOMAIN", domain.id, this.policySnapshot(domain.hostname, domain.mailSignature), userId);
    await this.prisma.domainSignature.upsert({
      where: { domainId },
      create: { domainId, ...input },
      update: input,
    });
    await this.auditLog.log(userId, "domain.mail_signature_updated", { type: "Domain", id: domain.id }, {
      after: {
        enabled: input.enabled,
        locked: input.locked,
        enforceServerSide: input.enforceServerSide,
        senderListMode: input.senderListMode,
        complianceEnabled: input.complianceEnabled,
      },
    });
    return this.getDomain(userId, domainId, await this.sync.syncDomain(domainId));
  }

  async listDomainVersions(userId: string, domainId: string): Promise<SignatureVersionResponse[]> {
    await this.ownedDomain(userId, domainId);
    return this.listVersions("DOMAIN", domainId);
  }

  async restoreDomainVersion(userId: string, domainId: string, versionId: string): Promise<DomainSignatureResponse> {
    await this.ownedDomain(userId, domainId);
    const version = await this.findVersion("DOMAIN", domainId, versionId);
    const snapshot = DomainSignaturePolicySchema.safeParse(version.snapshot);
    if (!snapshot.success) throw new SignatureError("That version can't be restored", "VERSION_INVALID", 422);
    return this.updateDomain(userId, domainId, snapshot.data);
  }

  // ── Groups ─────────────────────────────────────────────────────────────

  async createGroup(userId: string, domainId: string, input: GroupInput) {
    await this.ownedDomain(userId, domainId);
    if ((await this.prisma.signatureGroup.count({ where: { domainId } })) >= MAX_GROUPS) {
      throw new SignatureError(`A domain can have at most ${MAX_GROUPS} groups`, "TOO_MANY_GROUPS", 409);
    }
    await this.assertGroupNameFree(domainId, input.name);
    await this.prisma.signatureGroup.create({ data: { domainId, name: input.name, template: input.template } });
    return this.afterDomainChange(userId, domainId, "group_created");
  }

  async updateGroup(userId: string, domainId: string, groupId: string, input: GroupInput) {
    await this.ownedDomain(userId, domainId);
    const group = await this.prisma.signatureGroup.findFirst({ where: { id: groupId, domainId } });
    if (!group) throw notFound("group");
    if (group.name !== input.name) await this.assertGroupNameFree(domainId, input.name);
    await this.prisma.signatureGroup.update({ where: { id: groupId }, data: { name: input.name, template: input.template } });
    return this.afterDomainChange(userId, domainId, "group_updated");
  }

  async deleteGroup(userId: string, domainId: string, groupId: string) {
    await this.ownedDomain(userId, domainId);
    const group = await this.prisma.signatureGroup.findFirst({ where: { id: groupId, domainId } });
    if (!group) throw notFound("group");
    // Members fall back to the domain template (the relation sets their group to null).
    await this.prisma.signatureGroup.delete({ where: { id: groupId } });
    return this.afterDomainChange(userId, domainId, "group_deleted");
  }

  // ── Banners ────────────────────────────────────────────────────────────

  async createBanner(userId: string, domainId: string, input: BannerInput) {
    await this.ownedDomain(userId, domainId);
    if ((await this.prisma.signatureBanner.count({ where: { domainId } })) >= MAX_BANNERS) {
      throw new SignatureError(`A domain can have at most ${MAX_BANNERS} banners`, "TOO_MANY_BANNERS", 409);
    }
    await this.assertGroupBelongs(domainId, input.groupId);
    await this.prisma.signatureBanner.create({ data: this.bannerData(domainId, input) });
    return this.afterDomainChange(userId, domainId, "banner_created");
  }

  async updateBanner(userId: string, domainId: string, bannerId: string, input: BannerInput) {
    await this.ownedDomain(userId, domainId);
    if (!(await this.prisma.signatureBanner.findFirst({ where: { id: bannerId, domainId } }))) throw notFound("banner");
    await this.assertGroupBelongs(domainId, input.groupId);
    await this.prisma.signatureBanner.update({ where: { id: bannerId }, data: this.bannerData(domainId, input) });
    return this.afterDomainChange(userId, domainId, "banner_updated");
  }

  async deleteBanner(userId: string, domainId: string, bannerId: string) {
    await this.ownedDomain(userId, domainId);
    if (!(await this.prisma.signatureBanner.findFirst({ where: { id: bannerId, domainId } }))) throw notFound("banner");
    await this.prisma.signatureBanner.delete({ where: { id: bannerId } });
    return this.afterDomainChange(userId, domainId, "banner_deleted");
  }

  // ── Bulk apply ─────────────────────────────────────────────────────────

  /** Changes many mailboxes at once. With dryRun it only counts them, so nothing surprises the owner. */
  async bulk(userId: string, domainId: string, input: SignatureBulkInput): Promise<SignatureBulkResult> {
    await this.ownedDomain(userId, domainId);
    const mailboxes = await this.prisma.mailbox.findMany({
      where: { domainId },
      select: { id: true, signature: true },
    });

    const targetGroup = input.action === "ASSIGN_GROUP" ? (input.groupId ?? null) : null;
    if (targetGroup) await this.assertGroupBelongs(domainId, targetGroup);

    const affected = mailboxes.filter(({ signature }) => {
      if (input.action === "RESET_TO_DEFAULT") {
        return !!signature && (signature.mode !== "INHERIT" || signature.template !== null || signature.groupId !== null);
      }
      return (signature?.groupId ?? null) !== targetGroup;
    });

    if (input.dryRun || affected.length === 0) {
      return { dryRun: input.dryRun, affected: affected.length, total: mailboxes.length };
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    await this.prisma.$transaction([
      this.prisma.signatureVersion.createMany({
        data: affected.map(({ id, signature }) => ({
          scope: "MAILBOX" as const,
          targetId: id,
          snapshot: this.mailboxSnapshot(signature) as Prisma.InputJsonValue,
          createdById: userId,
          createdByEmail: user?.email ?? null,
        })),
      }),
      ...affected.map(({ id }) =>
        input.action === "RESET_TO_DEFAULT"
          ? this.prisma.mailboxSignature.update({
              where: { mailboxId: id },
              data: { mode: "INHERIT", template: null, groupId: null },
            })
          : this.prisma.mailboxSignature.upsert({
              where: { mailboxId: id },
              create: { mailboxId: id, groupId: targetGroup },
              update: { groupId: targetGroup },
            }),
      ),
    ]);

    await this.auditLog.log(userId, "domain.mail_signature_updated", { type: "Domain", id: domainId }, {
      after: { bulk: input.action, mailboxes: affected.length },
    });
    const syncWarning = await this.sync.syncDomain(domainId);
    return { dryRun: false, affected: affected.length, total: mailboxes.length, ...(syncWarning ? { syncWarning } : {}) };
  }

  // ── Export / import ────────────────────────────────────────────────────

  async exportDomain(userId: string, domainId: string): Promise<SignatureExport> {
    const domain = await this.ownedDomain(userId, domainId);
    const [groups, banners] = await Promise.all([
      this.prisma.signatureGroup.findMany({ where: { domainId }, orderBy: { name: "asc" } }),
      this.prisma.signatureBanner.findMany({ where: { domainId }, orderBy: { startsAt: "asc" } }),
    ]);
    const { hostname: _hostname, senderList: _list, senderListMode: _mode, ...policy } = toDomainPolicy(domain.hostname, domain.mailSignature);

    return {
      format: SIGNATURE_EXPORT_FORMAT,
      version: 1,
      policy,
      groups: groups.map((g) => ({ name: g.name, template: g.template })),
      banners: banners.map((b) => ({
        group: groups.find((g) => g.id === b.groupId)?.name ?? null,
        text: b.text,
        startsAt: b.startsAt.toISOString(),
        endsAt: b.endsAt.toISOString(),
        enabled: b.enabled,
      })),
    };
  }

  /**
   * Applies an exported template to this domain. The policy is replaced (the sender list is kept),
   * groups are matched by name and updated or added (never deleted, so no mailbox loses its group),
   * and banners are replaced because they are short-lived notices.
   */
  async importDomain(userId: string, domainId: string, input: SignatureExport): Promise<DomainSignatureResponse> {
    const domain = await this.ownedDomain(userId, domainId);
    const current = toDomainPolicy(domain.hostname, domain.mailSignature);
    await this.recordVersion("DOMAIN", domain.id, this.policySnapshot(domain.hostname, domain.mailSignature), userId);

    const existing = await this.prisma.signatureGroup.findMany({ where: { domainId } });
    const names = new Set(existing.map((g) => g.name));
    const additions = input.groups.filter((g) => !names.has(g.name));
    if (existing.length + additions.length > MAX_GROUPS) {
      throw new SignatureError(`A domain can have at most ${MAX_GROUPS} groups`, "TOO_MANY_GROUPS", 409);
    }

    const groupIdByName = new Map(existing.map((g) => [g.name, g.id] as const));
    const policyData = { ...input.policy, senderListMode: current.senderListMode, senderList: current.senderList };
    await this.prisma.$transaction(async (tx) => {
      await tx.domainSignature.upsert({ where: { domainId }, create: { domainId, ...policyData }, update: policyData });
      for (const group of input.groups) {
        const known = groupIdByName.get(group.name);
        if (known) {
          await tx.signatureGroup.update({ where: { id: known }, data: { template: group.template } });
        } else {
          const created = await tx.signatureGroup.create({ data: { domainId, name: group.name, template: group.template } });
          groupIdByName.set(group.name, created.id);
        }
      }
      await tx.signatureBanner.deleteMany({ where: { domainId } });
      for (const banner of input.banners) {
        const groupId = banner.group ? (groupIdByName.get(banner.group) ?? null) : null;
        await tx.signatureBanner.create({
          data: {
            domainId,
            groupId,
            text: banner.text,
            startsAt: new Date(banner.startsAt),
            endsAt: new Date(banner.endsAt),
            enabled: banner.enabled,
          },
        });
      }
    });

    await this.auditLog.log(userId, "domain.mail_signature_updated", { type: "Domain", id: domainId }, {
      after: { imported: true, groups: input.groups.length, banners: input.banners.length },
    });
    return this.getDomain(userId, domainId, await this.sync.syncDomain(domainId));
  }

  // ── Logos ──────────────────────────────────────────────────────────────

  async uploadLogo(userId: string, domainId: string, bytes: Buffer) {
    await this.ownedDomain(userId, domainId);
    if (bytes.length === 0) throw new SignatureError("The file is empty", "EMPTY_FILE", 400);
    if (bytes.length > SIGNATURE_LOGO_MAX_BYTES) {
      throw new SignatureError(`Logos can be at most ${SIGNATURE_LOGO_MAX_BYTES / 1024} KB`, "LOGO_TOO_LARGE", 413);
    }
    const type = detectLogoType(bytes);
    if (!type) throw new SignatureError("Use a PNG, JPEG, GIF or WebP image", "UNSUPPORTED_IMAGE", 415);
    if ((await this.prisma.signatureAsset.count({ where: { domainId } })) >= MAX_ASSETS) {
      throw new SignatureError(`A domain can keep at most ${MAX_ASSETS} logos. Delete one first.`, "TOO_MANY_LOGOS", 409);
    }

    const fileName = `${randomBytes(16).toString("hex")}.${type.extension}`;
    const directory = path.resolve(env.SIGNATURE_ASSETS_DIR);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, fileName), bytes, { flag: "wx" });

    const asset = await this.prisma.signatureAsset.create({
      data: { domainId, fileName, contentType: type.contentType, size: bytes.length },
    });
    return { id: asset.id, url: assetUrl(asset.fileName), size: asset.size, createdAt: asset.createdAt.toISOString() };
  }

  async deleteLogo(userId: string, domainId: string, assetId: string): Promise<DomainSignatureResponse> {
    const domain = await this.ownedDomain(userId, domainId);
    const asset = await this.prisma.signatureAsset.findFirst({ where: { id: assetId, domainId } });
    if (!asset) throw notFound("logo");

    await this.prisma.signatureAsset.delete({ where: { id: asset.id } });
    await fs.rm(path.join(path.resolve(env.SIGNATURE_ASSETS_DIR), asset.fileName), { force: true });

    // A signature must not keep pointing at an image that is gone.
    if (domain.mailSignature?.logoUrl === assetUrl(asset.fileName)) {
      await this.prisma.domainSignature.update({ where: { domainId }, data: { logoUrl: null } });
    }
    return this.afterDomainChange(userId, domainId, "logo_deleted");
  }

  /** For the public image route: the stored file, or null when the name is unknown. */
  async findPublicAsset(fileName: string): Promise<{ filePath: string; contentType: string; size: number } | null> {
    if (!ASSET_FILE_NAME.test(fileName)) return null;
    const asset = await this.prisma.signatureAsset.findUnique({ where: { fileName } });
    if (!asset) return null;
    return {
      filePath: path.join(path.resolve(env.SIGNATURE_ASSETS_DIR), asset.fileName),
      contentType: asset.contentType,
      size: asset.size,
    };
  }

  // ── Global switch (admin) ──────────────────────────────────────────────

  async getEnforcement(): Promise<SignatureEnforcementStatus> {
    const settings = await this.prisma.systemSettings.findUnique({ where: { id: "default" }, select: { signatureEnforcement: true } });
    let stats: SignatureEnforcementStatus["stats"] = null;
    try {
      const result = await runSignatureManager<{ stats: SignatureEnforcementStatus["stats"] }>("stats");
      stats = result.stats;
    } catch {
      // The mail container may not be running; the switch still works.
    }
    return { enabled: settings?.signatureEnforcement ?? true, stats };
  }

  async setEnforcement(actorId: string, enabled: boolean): Promise<SignatureEnforcementStatus & { syncWarning?: string }> {
    await this.prisma.systemSettings.upsert({
      where: { id: "default" },
      update: { signatureEnforcement: enabled },
      create: { id: "default", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, signatureEnforcement: enabled },
    });
    await this.auditLog.log(actorId, "mail.signature_enforcement_changed", { type: "System", id: "default" }, {
      after: { enabled },
    });
    const syncWarning = await this.sync.setGlobal(enabled);
    return { ...(await this.getEnforcement()), ...(syncWarning ? { syncWarning } : {}) };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async ownedMailbox(userId: string, mailboxId: string) {
    const mailbox = await this.prisma.mailbox.findFirst({
      where: { id: mailboxId, userId },
      include: { signature: true },
    });
    if (!mailbox) throw notFound("mailbox");
    return mailbox;
  }

  private async ownedDomain(userId: string, domainId: string) {
    const domain = await this.prisma.domain.findFirst({ where: { id: domainId, userId }, include: { mailSignature: true } });
    if (!domain) throw notFound("domain");
    return domain;
  }

  private async domainContext(domainId: string) {
    const domain = await this.prisma.domain.findUniqueOrThrow({
      where: { id: domainId },
      include: { mailSignature: true, signatureGroups: true, signatureBanners: true },
    });
    return {
      policy: toDomainPolicy(domain.hostname, domain.mailSignature),
      groups: domain.signatureGroups,
      banners: domain.signatureBanners,
    };
  }

  private async afterDomainChange(userId: string, domainId: string, change: string): Promise<DomainSignatureResponse> {
    await this.auditLog.log(userId, "domain.mail_signature_updated", { type: "Domain", id: domainId }, { after: { change } });
    return this.getDomain(userId, domainId, await this.sync.syncDomain(domainId));
  }

  private async assertGroupNameFree(domainId: string, name: string) {
    if (await this.prisma.signatureGroup.findUnique({ where: { domainId_name: { domainId, name } } })) {
      throw new SignatureError(`A group named "${name}" already exists`, "GROUP_EXISTS", 409);
    }
  }

  private async assertGroupBelongs(domainId: string, groupId: string | null | undefined) {
    if (groupId && !(await this.prisma.signatureGroup.findFirst({ where: { id: groupId, domainId } }))) {
      throw new SignatureError("That group doesn't belong to this domain", "GROUP_NOT_FOUND", 400);
    }
  }

  private bannerData(domainId: string, input: BannerInput) {
    return {
      domainId,
      groupId: input.groupId ?? null,
      text: input.text,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      enabled: input.enabled,
    };
  }

  private mailboxSnapshot(row: Parameters<typeof toMailboxSettings>[0]) {
    return { ...toMailboxSettings(row) };
  }

  private policySnapshot(hostname: string, row: Parameters<typeof toDomainPolicy>[1]) {
    const { hostname: _hostname, ...policy } = toDomainPolicy(hostname, row);
    return policy;
  }

  private async recordVersion(scope: "DOMAIN" | "MAILBOX", targetId: string, snapshot: object, userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    await this.prisma.signatureVersion.create({
      data: { scope, targetId, snapshot: snapshot as Prisma.InputJsonValue, createdById: userId, createdByEmail: user?.email ?? null },
    });
    const stale = await this.prisma.signatureVersion.findMany({
      where: { scope, targetId },
      orderBy: { createdAt: "desc" },
      skip: SIGNATURE_VERSIONS_KEPT,
      select: { id: true },
    });
    if (stale.length > 0) {
      await this.prisma.signatureVersion.deleteMany({ where: { id: { in: stale.map((version) => version.id) } } });
    }
  }

  private async listVersions(scope: "DOMAIN" | "MAILBOX", targetId: string): Promise<SignatureVersionResponse[]> {
    const versions = await this.prisma.signatureVersion.findMany({
      where: { scope, targetId },
      orderBy: { createdAt: "desc" },
      take: SIGNATURE_VERSIONS_KEPT,
    });
    return versions.map((v) => ({ id: v.id, createdAt: v.createdAt.toISOString(), createdByEmail: v.createdByEmail }));
  }

  private async findVersion(scope: "DOMAIN" | "MAILBOX", targetId: string, versionId: string) {
    const version = await this.prisma.signatureVersion.findFirst({ where: { id: versionId, scope, targetId } });
    if (!version) throw notFound("version");
    return version;
  }
}

