import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { AuditLogService } from "../src/modules/audit-log/service.js";
import { RecoveryError, recoverAccount } from "../src/modules/auth/password-recovery.js";
import { panelUrl } from "../src/modules/system-email/templates.js";

/**
 * Server-side account recovery (F5.30) — the way back in when an admin (or
 * anyone) is locked out. Run on the host through the one-off container, the
 * same way the installer runs create-admin.ts:
 *
 *   docker compose --env-file /etc/vexlyx/vexlyx.env -f docker-compose.yml \
 *     -f docker-compose.prod.yml run --rm --no-deps api \
 *     pnpm exec tsx prisma/reset-password.ts --email admin@example.com
 *
 * Default prints a single-use reset link, so no password ever lands in shell
 * history. Shell access is the proof of ownership, which is why this works for
 * admin accounts when the emailed flow deliberately does not.
 */
const USAGE = `Usage: tsx prisma/reset-password.ts --email <address> [options]

Options:
  --link            Print a single-use reset link (default when nothing else is given)
  --password-stdin  Set the password from stdin instead, e.g.
                      printf '%s' 'a long passphrase' | tsx prisma/reset-password.ts --email <address> --password-stdin
  --disable-2fa     Turn off two-factor authentication for the account
  -h, --help        Show this help
`;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function parseArgs(argv: string[]) {
  const args = { email: "", link: false, passwordStdin: false, disable2fa: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--email") args.email = argv[++i] ?? "";
    else if (arg?.startsWith("--email=")) args.email = arg.slice("--email=".length);
    else if (arg === "--link") args.link = true;
    else if (arg === "--password-stdin") args.passwordStdin = true;
    else if (arg === "--disable-2fa") args.disable2fa = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.email) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  let newPassword: string | undefined;
  if (args.passwordStdin) {
    newPassword = (await readStdin()).replace(/\r?\n$/, "");
  }

  const prisma = new PrismaClient();
  const needsRedis = newPassword !== undefined || args.disable2fa;
  const redis = needsRedis ? new Redis(process.env.REDIS_URL ?? "redis://localhost:6379") : undefined;
  const audit = new AuditLogService(prisma, {
    error: (obj: unknown, message: string) => console.error(message, obj),
  } as never);

  try {
    const result = await recoverAccount(
      { prisma, redis, audit, buildUrl: panelUrl },
      { email: args.email, link: args.link, newPassword, disable2fa: args.disable2fa },
    );

    if (result.passwordChanged) console.log(`Password updated for ${result.email}. All of its sessions were ended.`);
    if (result.twoFactorDisabled) console.log(`Two-factor authentication disabled for ${result.email}. All of its sessions were ended.`);
    if (result.resetUrl) {
      console.log(`Reset link for ${result.email} (single use, expires in ${result.expiresMinutes} minutes):`);
      console.log(result.resetUrl);
    }
  } finally {
    redis?.disconnect();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof RecoveryError) {
    console.error(error.message);
  } else {
    console.error("Account recovery failed:", error);
  }
  process.exit(1);
});
