# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.** Email
**hello@atlantiqs.org** with:

- A description of the issue and its potential impact.
- Steps to reproduce it, or a proof of concept.
- The version/commit you tested against.

We'll acknowledge your report and work with you on a fix before any public disclosure. Please
give us a reasonable amount of time to address the issue before disclosing it elsewhere.

## Supported versions

Vexlyx is pre-1.0 and does not yet maintain parallel release branches. Security fixes land on
`main` and are covered by the [installer](docs/dev/installer.md)'s upgrade path — re-running the
installer on an existing server pulls the latest fixes. There is no support for versions other
than the current `main`.

## Scope

In scope: the Vexlyx codebase itself (`apps/`, `packages/`, `system/`, the installer, and Docker
configs in this repository) and the deployment it produces.

Out of scope: the security of a project *you deploy through* Vexlyx (that project's own code and
dependencies), and misconfiguration of a server you administer yourself outside of what the
installer/panel does on your behalf.

## What's already handled

Vexlyx bakes in a number of practices by default rather than leaving them to the operator:
password hashing with Argon2id, encryption at rest (AES-256-GCM) for stored secrets such as
project environment variables and database credentials, HTTP-only session cookies (no tokens in
`localStorage`), rate-limited auth endpoints, and firewall changes that refuse to lock out SSH or
the panel's own port (see [Operations](https://docs.vexlyx.atlantiqs.org/guide/operations) for the
last one). None of that makes a report unwelcome — if you find a way around any of it, that's
exactly what this policy is for.
