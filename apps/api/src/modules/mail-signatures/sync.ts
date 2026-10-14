import fs from "node:fs/promises";
import path from "node:path";
import type { DomainSignature, MailboxSignature, PrismaClient } from "@prisma/client";
import type { SignatureFile } from "@vexlyx/shared";
import { env } from "../../config/env.js";
import { ASSET_FILE_NAME } from "./assets.js";
import { runSignatureManager } from "./manager.js";
import {
  DEFAULT_MAILBOX_SETTINGS,
  buildSignatureFile,
  defaultDomainPolicy,
  type DomainPolicy,
  type MailboxSettings,
} from "./resolve.js";

export function toDomainPolicy(hostname: string, row: DomainSignature | null | undefined): DomainPolicy {
  if (!row) return defaultDomainPolicy(hostname);
  return {
    hostname,
    enabled: row.enabled,
    template: row.template,
    company: row.company,
    website: row.website,
    logoUrl: row.logoUrl,
    locked: row.locked,
    enforceServerSide: row.enforceServerSide,
    externalOnly: row.externalOnly,
    newMessagesOnly: row.newMessagesOnly,
    senderListMode: row.senderListMode,
    senderList: row.senderList.map((address) => address.toLowerCase()),
    complianceEnabled: row.complianceEnabled,
    complianceText: row.complianceText,
  };
}

export function toMailboxSettings(row: MailboxSignature | null | undefined): MailboxSettings {
  if (!row) return DEFAULT_MAILBOX_SETTINGS;
  return {
    mode: row.mode,
    template: row.template,
    groupId: row.groupId,
    displayName: row.displayName,
    title: row.title,
    department: row.department,
    phone: row.phone,
    mobile: row.mobile,
  };
}

interface LoggerLike {
  error(obj: unknown, message: string): void;
}

type Runner = typeof runSignatureManager;

/**
 * Keeps the per-mailbox signature files in step with the database. The database
 * change has already succeeded by the time this runs, so a failure here never
 * undoes it: it is logged and returned as a message the API hands back to the
 * dashboard, which tells the user the mail servers have not caught up yet.
 */
export class SignatureSync {
  constructor(
    private prisma: PrismaClient,
    private logger?: LoggerLike,
    private run: Runner = runSignatureManager,
  ) {}

  /** Writes or removes the file for one mailbox. Returns null on success, otherwise a message. */
  async syncMailbox(mailboxId: string): Promise<string | null> {
    const mailbox = await this.prisma.mailbox.findUnique({
      where: { id: mailboxId },
      include: { signature: true, domain: { include: { mailSignature: true, signatureGroups: true, signatureBanners: true } } },
    });
    if (!mailbox) return null;

    const file = await this.buildFile(mailbox, mailbox.domain);
    return this.apply(file ? [{ address: mailbox.address, data: file }] : [], file ? [] : [mailbox.address]);
  }

  /** Rewrites every mailbox of a domain and removes files for mailboxes that no longer have one. */
  async syncDomain(domainId: string): Promise<string | null> {
    const domain = await this.prisma.domain.findUnique({
      where: { id: domainId },
      include: {
        mailSignature: true,
        signatureGroups: true,
        signatureBanners: true,
        mailboxes: { include: { signature: true } },
      },
    });
    if (!domain) return null;

    const internalDomains = await this.internalDomains(domain.userId);
    const files: Array<{ address: string; data: SignatureFile }> = [];
    const remove: string[] = [];
    for (const mailbox of domain.mailboxes) {
      const file = await this.buildFile(mailbox, domain, internalDomains);
      if (file) files.push({ address: mailbox.address, data: file });
      else remove.push(mailbox.address);
    }

    const problem = await this.apply(files, remove);
    if (problem) return problem;
    // Files left behind by a deleted mailbox would otherwise live on.
    return this.guard(() =>
      this.run("prune_domain", { domain: domain.hostname, keep: domain.mailboxes.map((m) => m.address) }),
    );
  }

  async removeAddresses(addresses: string[]): Promise<string | null> {
    if (addresses.length === 0) return null;
    return this.apply([], addresses);
  }

  /** Removes every file of a domain, e.g. when the domain is deleted. */
  async removeDomain(hostname: string): Promise<string | null> {
    return this.guard(() => this.run("prune_domain", { domain: hostname, keep: [] }));
  }

  /** Logo file names of a domain, collected before the domain (and its rows) is deleted. */
  async assetFileNames(domainId: string): Promise<string[]> {
    const rows = await this.prisma.signatureAsset.findMany({ where: { domainId }, select: { fileName: true } });
    return rows.map((row) => row.fileName);
  }

  async deleteAssetFiles(fileNames: string[]): Promise<void> {
    const directory = path.resolve(env.SIGNATURE_ASSETS_DIR);
    for (const name of fileNames) {
      if (ASSET_FILE_NAME.test(name)) await fs.rm(path.join(directory, name), { force: true });
    }
  }

  /**
   * Removes logo files that no database row points to (left behind when a user or domain was
   * deleted). Files younger than an hour are kept, since an upload writes the file just before its row.
   */
  async sweepOrphanAssets(): Promise<number> {
    const directory = path.resolve(env.SIGNATURE_ASSETS_DIR);
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch {
      return 0;
    }
    const candidates = names.filter((name) => ASSET_FILE_NAME.test(name));
    if (candidates.length === 0) return 0;

    const known = new Set(
      (await this.prisma.signatureAsset.findMany({ where: { fileName: { in: candidates } }, select: { fileName: true } })).map(
        (row) => row.fileName,
      ),
    );
    let removed = 0;
    for (const name of candidates) {
      if (known.has(name)) continue;
      const stat = await fs.stat(path.join(directory, name)).catch(() => null);
      if (!stat || Date.now() - stat.mtimeMs < 3_600_000) continue;
      await fs.rm(path.join(directory, name), { force: true });
      removed += 1;
    }
    return removed;
  }

  async setGlobal(enabled: boolean): Promise<string | null> {
    return this.guard(() => this.run("set_global", { enabled }));
  }

  private async internalDomains(userId: string): Promise<string[]> {
    const domains = await this.prisma.domain.findMany({ where: { userId }, select: { hostname: true } });
    return domains.map((domain) => domain.hostname);
  }

  private async buildFile(
    mailbox: { address: string; status: string; userId: string; signature: MailboxSignature | null },
    domain: {
      hostname: string;
      mailSignature: DomainSignature | null;
      signatureGroups: Array<{ id: string; name: string; template: string }>;
      signatureBanners: Array<{ groupId: string | null; text: string; startsAt: Date; endsAt: Date; enabled: boolean }>;
    },
    internalDomains?: string[],
  ): Promise<SignatureFile | null> {
    if (mailbox.status !== "ACTIVE") return null;
    const settings = toMailboxSettings(mailbox.signature);
    return buildSignatureFile({
      address: mailbox.address,
      domain: toDomainPolicy(domain.hostname, domain.mailSignature),
      mailbox: settings,
      group: domain.signatureGroups.find((group) => group.id === settings.groupId) ?? null,
      banners: domain.signatureBanners,
      internalDomains: internalDomains ?? (await this.internalDomains(mailbox.userId)),
      now: new Date(),
    });
  }

  private apply(files: Array<{ address: string; data: SignatureFile }>, remove: string[]): Promise<string | null> {
    if (files.length === 0 && remove.length === 0) return Promise.resolve(null);
    return this.guard(() => this.run("sync", { files, remove }));
  }

  private async guard(action: () => Promise<unknown>): Promise<string | null> {
    try {
      await action();
      return null;
    } catch (err) {
      this.logger?.error({ err }, "Could not update the mail signature files");
      return err instanceof Error ? err.message : "Could not update the mail signature files";
    }
  }
}
