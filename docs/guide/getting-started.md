# Getting Started

This walks through installing Vexlyx on a fresh server, logging in for the first time, and
deploying your first project. It should take about 15–20 minutes, most of which is the installer
running unattended.

## What you need

- A server running **Ubuntu 24.04** (`x86_64` or `aarch64`), with root access. Other distros and
  architectures aren't tested by the installer.
- A domain you control, e.g. `example.com`, with access to its DNS records.
- Before you install, point an **A record** for that domain (and, if you want mail, an **MX
  record**) at the server's public IP. Vexlyx requests a real Let's Encrypt certificate for the
  panel during install, which requires the domain to already resolve to the server.

You don't need Docker, Node, or Python installed beforehand — the installer sets all of that up.

## Install

SSH into the server as root (or a user that can `sudo`) and run:

```bash
curl -fsSL https://vexlyx.atlantiqs.org/install.sh | bash
```

Piped this way, the installer has no interactive terminal, so it won't prompt you for
anything — it needs `VEXLYX_DOMAIN` set in the environment, or it exits with instructions. Set at
least your domain and admin email:

```bash
VEXLYX_DOMAIN=example.com VEXLYX_ADMIN_EMAIL=you@example.com \
  curl -fsSL https://vexlyx.atlantiqs.org/install.sh | bash
```

If you'd rather be prompted interactively for the domain, admin email, and password, download the
script first instead of piping it directly into `bash`:

```bash
curl -fsSL https://vexlyx.atlantiqs.org/install.sh -o install.sh
sudo bash install.sh
```

The installer installs Docker, Node.js, and Python; builds the dashboard and API; brings up
Postgres, Redis, Traefik (with your certificate), the mail stack, and the panel itself; and
configures the firewall. It checks real state before each step, so if it fails partway through —
a flaky package mirror, a slow DNS propagation — re-running the exact same command picks up where
it left off rather than starting over or duplicating anything.

At the end it prints a summary with your panel URL and admin credentials. **If you didn't set
`VEXLYX_ADMIN_PASSWORD` yourself, the generated password is shown here once and not stored
anywhere** — copy it before closing the terminal.

For everything the installer configures — every environment variable, what gets generated versus
prompted, and the full list of bugs found and fixed during a real end-to-end install — see the
[installer reference](/reference/installer).

## Log in

Open `https://` followed by the domain you set as `VEXLYX_DOMAIN`. You'll land on the login page,
served over the real certificate the installer requested. Sign in with the admin email and
password from the install summary.

The dashboard home page shows your resource counts (projects, domains, databases, mailboxes),
server health, and recent activity — all zero/empty on a fresh install, with a "Getting Started"
prompt that disappears once you've created your first project.

## Deploy your first project

1. Go to **Projects** in the sidebar and click **New Project**.
2. Give it a name — this also becomes its default subdomain, so `my-app` deploys to
   `my-app.example.com` automatically, with HTTPS, no DNS setup required.
3. Pick a type: Next.js, Node.js, Python, React (Vite), Static, PHP, WordPress, or Docker
   (a project with its own Dockerfile). Vexlyx builds each type differently — see
   [Runtimes](/reference/runtimes/nextjs) for what each one expects.
4. Optionally add a Git URL to deploy from a repository. Leave it out to create the project first
   and connect a repo or push code later.
5. Submit. The project appears in the grid immediately with a **Creating** status; open it to
   watch the build.

Once the build finishes and the project is **Active**, visit `https://<name>.<your-domain>` to
see it live.

## Next steps

- **Connect a Git repo, set up auto-deploy on push, or deploy a different project type** — see
  [Deploying a project](/guide/deploying).
- **Use your own domain instead of the generated subdomain** — see
  [Domains, subdomains and SSL](/guide/domains-and-ssl).
- **Set up mailboxes** for your domain — see the [Email](/reference/email/postfix) section.
- **Add teammates with limited access** — see [Roles and permissions](/reference/roles-permissions).
- **Back up your data, watch resource usage, and manage users** — see
  [Operations](/guide/operations).

If something doesn't work as described here, see [Troubleshooting](/guide/troubleshooting), or
open an issue on [GitHub](https://github.com/atlantiqshq/vexlyx).
