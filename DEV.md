# DEV.md

> **Project:** Vexlyx
> **Audience:** Developers building Vexlyx (solo or team)
> **Purpose:** How to use AI (Claude) for vibe coding this project
> **Prerequisite:** Read `CLAUDE.md` first for project conventions

---

## What is Vibe Coding?

Vibe coding is building software by describing what you want in natural language, and letting AI (Claude, Cursor, GitHub Copilot) write the actual code. You don't write every line — you describe the architecture, review the output, test it, and iterate.

**For Vexlyx, this means:**
- You describe a feature (e.g., "Build the authentication system")
- Claude reads `CLAUDE.md` and `FEATURES.md` for context
- Claude generates the code following project conventions
- You test it, give feedback, and Claude fixes issues
- Claude writes the developer docs when you're satisfied

**You are the architect. Claude is the builder.**

---

## The Vibe Coding Loop

Every feature follows this exact cycle:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│    PLAN     │────▶│    CODE     │────▶│    TEST     │────▶│  DOCUMENT   │
│  (Claude)   │     │  (Claude)   │     │   (You)     │     │  (Claude)   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       ▲                                                            │
       └────────────────────────────────────────────────────────────┘
                              (Next Feature)
```

---

## Before You Start

### 1. Set Up Your Environment

You need:
- **Node.js 22+** and **pnpm** (package manager) — pnpm 11 requires Node 22 for the `node:sqlite` built-in
- **Docker** and **Docker Compose**
- **Git** with your GitHub account configured
- **Claude** (claude.ai or Claude Desktop App)
- A code editor (VS Code recommended)

### 2. Understand the Three Core Files

| File | Purpose | Who Maintains |
|------|---------|---------------|
| `FEATURES.md` | The roadmap. Every feature, its status, test plan, and docs location. | **You** update after each feature |
| `CLAUDE.md` | The constitution. Code conventions, design system, architecture rules. | **You** update when conventions change |
| `DEV.md` | This file. How to work with AI to build the project. | **You** update as workflow improves |

**Rule:** Claude reads `CLAUDE.md` and `FEATURES.md` at the start of every session. You read `DEV.md` whenever you need a refresher on the workflow.

### 3. Create Your GitHub Repository

```bash
# On GitHub (web interface):
# 1. Click "New Repository"
# 2. Name: vexlyx
# 3. Visibility: Public
# 4. Do NOT initialize with README (you'll push your own)

# Then locally:
git init
git add .
git commit -m "chore: initialize vexlyx repository"
git branch -M main
git remote add origin https://github.com/atlantiqshq/vexlyx.git
git push -u origin main
```

**Use your personal GitHub account.** Do not create a separate "Vexlyx" account — it looks inauthentic. Your personal email is fine for git commits.

---

## The Session Workflow

### Step 1: Pick a Feature

Open `FEATURES.md` and find the next `🔴 NOT STARTED` feature in order. Do NOT skip ahead.

**Current order (Phase 0):**
1. F0.1 — Monorepo Setup
2. F0.2 — Next.js Dashboard Scaffold
3. F0.3 — Fastify API Scaffold
4. F0.4 — Prisma Schema & Database
5. F0.5 — Redis & Docker Compose Dev Environment
6. F0.6 — Authentication System
7. F0.7 — Shared Package (Types & Schemas)

### Step 2: Start a Claude Session

**Always start with this exact prompt:**

```
I'm building Vexlyx, an open-source hybrid hosting control panel.

Before we start, please:
1. Read CLAUDE.md for project conventions, tech stack, and design system
2. Read the feature section for [F0.X — Feature Name] in FEATURES.md
3. Ask me any clarifying questions before writing code

Do NOT install new dependencies without asking me first.
Do NOT skip the planning phase.
```

**Why this works:**
- Claude reads the project constitution first
- Claude knows exactly what feature to build
- Claude asks questions instead of guessing
- Claude won't add random dependencies

### Step 3: Planning Phase

Claude will ask questions or outline the approach. **Review this carefully.**

Example questions Claude might ask:
- "Should the sidebar be collapsible or fixed-width?"
- "Do you want OAuth (GitHub/Google) login in addition to email/password?"
- "Should project names be globally unique or unique per user?"

**Your job:** Answer clearly. If unsure, say "Keep it simple for now, we can add that later."

### Step 4: Coding Phase

Claude writes code. **Watch for these things:**

| Check | What to Look For |
|-------|-----------------|
| **Conventions** | Does it follow the patterns in `CLAUDE.md` Section 4? |
| **Design** | Does it use the color tokens and components from Section 15? |
| **Security** | Are passwords hashed? Is input validated with Zod? |
| **Dependencies** | Did Claude ask before installing anything new? |

**If something looks wrong, stop Claude immediately.** Say:
- "This doesn't match the pattern in `src/modules/auth/routes.ts`. Please follow that structure."
- "Use `cn()` for className, not template literals."
- "Don't use `any` type — use `unknown` with Zod validation."

### Step 5: Testing Phase

After Claude finishes coding, it will give you a test plan. **You must run these tests yourself.**

Example test plan from Claude:

```bash
# Test F0.1 — Monorepo Setup
1. Run: pnpm install
   Expected: All dependencies install without errors

2. Run: pnpm dev
   Expected: Turborepo starts all apps, dashboard on :3000, API on :5000

3. Run: pnpm build
   Expected: All packages build successfully, no TypeScript errors

4. Run: pnpm lint
   Expected: No ESLint or Prettier errors
```

**Your job:**
1. Run each command
2. Verify the expected result
3. If something fails, copy the error and tell Claude: "Test 3 failed with this error: [paste error]"
4. Claude fixes it. You test again.

**Do NOT say "tests passed" if you haven't actually run them.**

### Step 6: Mark Complete + Write Docs

Once all tests pass, tell Claude:

```
All tests passed for F0.X — [Feature Name].

Now do these two things:
1. Update FEATURES.md — change status from 🔴 NOT STARTED to 🟢 COMPLETED
2. Write developer documentation at docs/dev/[feature-name].md

The docs must include:
- What this feature does (2-3 sentences)
- Architecture / how it works
n- How to test it
- How to extend or modify it
- Any important decisions made
```

**Claude will:**
1. Update `FEATURES.md` with the new status
2. Create `docs/dev/[feature-name].md` with comprehensive documentation

**Your job:** Review the docs. Make sure they're clear enough that another developer (or AI) could understand the feature without reading the code.

### Step 7: Commit

```bash
git add .
git commit -m "feat: [F0.X] add [feature name]"
git push origin main
```

Use conventional commits:
- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation only
- `refactor:` — Code change that neither fixes a bug nor adds a feature
- `chore:` — Maintenance tasks

---

## Prompt Templates

### Template 1: Starting a New Feature

```
I'm building Vexlyx, an open-source hybrid hosting control panel.

Before we start, please:
1. Read CLAUDE.md for project conventions, tech stack, and design system
2. Read the feature section for [F0.X — Feature Name] in FEATURES.md
3. Ask me any clarifying questions before writing code

Do NOT install new dependencies without asking me first.
Do NOT skip the planning phase.
```

### Template 2: Fixing a Bug

```
Feature [F0.X — Feature Name] has a bug.

The issue: [Describe the bug clearly]

Steps to reproduce:
1. [Step 1]
2. [Step 2]
3. [Step 3]

Expected: [What should happen]
Actual: [What actually happens]

Error message: [Paste full error]

Please fix this. Read CLAUDE.md first for conventions.
```

### Template 3: Refactoring Existing Code

```
I need to refactor [file path or feature].

The goal: [What you want to change and why]

Constraints:
- Must follow patterns in CLAUDE.md
- Must not break existing tests
- Must maintain the same functionality

Please plan the refactoring first, then implement.
```

### Template 4: Marking Feature Complete

```
All tests passed for F0.X — [Feature Name].

Now do these two things:
1. Update FEATURES.md — change status from 🟡 IN PROGRESS to 🟢 COMPLETED
2. Write developer documentation at docs/dev/[feature-name].md

The docs must include:
- What this feature does (2-3 sentences)
- Architecture / how it works
- How to test it
- How to extend or modify it
- Any important decisions made
```

---

## Working with Claude: Best Practices

### 1. One Feature Per Session

**Never** ask Claude to build multiple unrelated features in one chat. Claude's context window is large but not infinite. Mixing auth + deployment + email in one session leads to:
- Confused code
- Missed requirements
- Inconsistent patterns

**Correct:**
- Session 1: "Build F0.1 — Monorepo Setup"
- Session 2: "Build F0.2 — Next.js Dashboard Scaffold"
- Session 3: "Build F0.3 — Fastify API Scaffold"

**Incorrect:**
- Session 1: "Build the monorepo, dashboard, and API all at once"

### 2. Use `/clear` Between Features

After completing a feature, type `/clear` to reset Claude's context. Then start fresh with the next feature's prompt. This prevents:
- Code from Feature A leaking into Feature B
- Claude getting confused about which feature you're building
- Context window filling up with old code

### 3. Point to Existing Patterns

When Claude is building something similar to an existing feature, say:

```
Follow the same pattern as src/modules/auth/routes.ts for the route structure.
Follow the same pattern as components/auth/LoginForm.tsx for the form handling.
```

This ensures consistency across the codebase.

### 4. Small Chunks for Complex Features

If a feature requires more than 5 files, break it into chunks:

```
Part 1: Build the API routes and service layer only. No frontend yet.
Part 2: Build the frontend components that consume the API.
Part 3: Wire them together and add error handling.
```

This makes testing easier and reduces errors.

### 5. Review Before Accepting

**Never** blindly accept Claude's code. Review every file for:
- Correctness (does it do what you asked?)
- Conventions (does it follow CLAUDE.md?)
- Security (are passwords hashed? Is input validated?)
- Dependencies (did it install anything without asking?)

### 6. Keep Claude Honest About Tests

Claude sometimes says "this should work" without actually testing. **Insist on concrete test plans:**

```
Don't just say "it should work." Give me the exact commands to run and the expected output for each step.
```

### 7. Save Working Code Immediately

After a successful feature completion:
1. Copy the code to your editor
2. Run the tests
3. Commit to git
4. Only THEN start the next feature

**Never** start a new feature before committing the previous one. If Claude's context resets, you could lose working code.

---

## Common Pitfalls and How to Avoid Them

### Pitfall 1: Claude Forgets Conventions

**Problem:** After 10+ messages, Claude starts using `Express` instead of `Fastify`, or `useState` instead of Zustand.

**Solution:** Remind Claude: "Remember we're using Fastify, not Express. Read CLAUDE.md Section 3."

### Pitfall 2: Claude Installs Random Dependencies

**Problem:** Claude installs `lodash`, `moment`, or other libraries without asking.

**Solution:** Your starter prompt includes "Do NOT install new dependencies without asking me first." If Claude violates this, say: "Remove that dependency and implement it with native code instead."

### Pitfall 3: Claude Writes Too Much Code at Once

**Problem:** Claude generates 500 lines of code in one response, making review impossible.

**Solution:** Say "Stop. Show me the API routes first. Once I approve, show me the service layer."

### Pitfall 4: Claude Uses Outdated Patterns

**Problem:** Claude suggests `React.FC`, `class` components, or `var` declarations.

**Solution:** Say "We use modern patterns only. Read CLAUDE.md Section 4 for our conventions."

### Pitfall 5: Claude Skips Error Handling

**Problem:** Claude writes the happy path but forgets error states, loading states, and edge cases.

**Solution:** Always ask: "What about error handling? What if the API returns 500? What if the user has no projects yet (empty state)?"

### Pitfall 6: Claude Hardcodes Values

**Problem:** Claude hardcodes API URLs, ports, or secrets.

**Solution:** Say "Use environment variables for all configurable values. Add them to .env.example."

### Pitfall 7: Claude Ignores the Design System

**Problem:** Claude uses random colors, heavy shadows, or inconsistent spacing.

**Solution:** Say "Follow the design system in CLAUDE.md Section 15. Use only the color tokens listed there."

---

## Testing Checklist for Every Feature

Before marking any feature complete, verify ALL of these:

- [ ] **Happy path works** — Normal operation succeeds
- [ ] **Error path handled** — Invalid input shows clear errors
- [ ] **Auth enforced** — Unauthorized access returns 401/403
- [ ] **TypeScript compiles** — `pnpm typecheck` passes
- [ ] **Linting passes** — `pnpm lint` passes
- [ ] **Build succeeds** — `pnpm build` passes
- [ ] **No console errors** — Browser console is clean
- [ ] **Responsive** — Works on desktop and tablet
- [ ] **Accessible** — Keyboard navigation works, ARIA labels present
- [ ] **Dark mode** — Both light and dark themes look correct

---

## Git Workflow

### Commit Messages

Use conventional commits with feature references:

```bash
# Feature complete
git commit -m "feat(F0.1): initialize turborepo monorepo with three workspaces"

# Bug fix
git commit -m "fix(F0.3): resolve health check endpoint timeout issue"

# Documentation
git commit -m "docs(F0.2): add dashboard setup developer guide"

# Refactor
git commit -m "refactor(F0.4): extract database config into separate module"
```

### Branching (Optional)

For solo development, `main` is fine. If you want cleaner history:

```bash
# Create feature branch
git checkout -b feat/F0.1-monorepo-setup

# Work on feature...

# Merge back
git checkout main
git merge feat/F0.1-monorepo-setup
git push origin main
```

### Pushing to GitHub

```bash
# After every feature completion
git add .
git commit -m "feat(F0.X): [description]"
git push origin main

# If you have uncommitted changes and want to start fresh
git stash
git pull origin main
git stash pop
```

---

## Documentation Workflow

Every feature gets two types of documentation:

### 1. Developer Docs (`docs/dev/[feature-name].md`)

Written by Claude after you confirm tests pass. Includes:
- What the feature does
- Architecture and key decisions
- How to test it
- How to extend it
- File structure

**Purpose:** So other developers (or AI) can understand and modify the feature.

### 2. User Docs (`docs/user/[feature-name].md`)

Written by you (or Claude at your request) later. Includes:
- How to use the feature
- Screenshots
- Common issues and solutions

**Purpose:** So users of Vexlyx know how to use the panel.

### 3. API Docs (Auto-generated)

Generated from Fastify route schemas using `@fastify/swagger`. Accessible at `/api/docs` when running locally.

---

## When to Update CLAUDE.md

Update `CLAUDE.md` when:
- You add a new convention (e.g., "we now use `z.coerce` for form inputs")
- You change the tech stack (e.g., switching from Zustand to Jotai)
- You discover a new anti-pattern to avoid
- You add new shadcn components to the approved list
- You change the design system

**Do NOT** update `CLAUDE.md` for:
- Feature-specific details (those go in `docs/dev/`)
- One-time decisions (those go in the Decision Log inside `CLAUDE.md`)
- Bug fixes (those go in commit messages)

---

## When to Update FEATURES.md

Update `FEATURES.md` when:
- A feature status changes (`🔴 → 🟡 → 🟢`)
- You discover a new feature that needs to be built
- You want to reprioritize features
- You want to add a new phase

**Do NOT** update `FEATURES.md` for:
- Bug fixes on existing features
- Documentation changes
- Refactoring

---

## Working with Multiple AIs

You might use Claude, Cursor, and GitHub Copilot together. Here's how:

| AI Tool | Best For | How to Use |
|---------|----------|-----------|
| **Claude** | Full features, architecture decisions, docs | Use the workflow in this file |
| **Cursor** | Inline code completion, quick fixes | Open the project in Cursor, let it autocomplete |
| **GitHub Copilot** | Boilerplate, repetitive patterns | Use in VS Code for quick suggestions |

**Important:** If you use Cursor or Copilot to modify code, make sure the output still follows `CLAUDE.md` conventions. If Cursor generates `Express` code instead of `Fastify`, correct it immediately.

---

## Solo vs Team Development

### Solo (You + AI)

- Work directly on `main` branch
- Commit after every feature
- FEATURES.md is your personal todo list
- No code reviews needed, but still test thoroughly

### Team (You + Other Humans + AI)

- Use Pull Requests for every feature
- Require at least one human review before merging
- FEATURES.md becomes the shared roadmap
- Assign features to team members
- Use GitHub Issues linked to FEATURES.md features

**Transitioning from solo to team:**
1. Create a `CONTRIBUTING.md` file
2. Set up branch protection on `main`
3. Require PR reviews
4. Add issue templates
5. Update `DEV.md` with team-specific workflows

---

## Performance Tips

### Speed Up Claude Sessions

1. **Use `/clear` between features** — Prevents context bloat
2. **Don't paste entire files** — Paste only the relevant function or component
3. **Use file references** — "See `src/modules/auth/routes.ts` line 45" instead of pasting the code
4. **Batch small fixes** — "Fix these 3 linting errors" is faster than 3 separate sessions

### Speed Up Your Testing

1. **Keep Docker running** — Don't stop/start between features
2. **Use `pnpm dev`** — Turborepo watches all packages, auto-reloads on change
3. **Keep Prisma Studio open** — Inspect database state without writing queries
4. **Use browser dev tools** — Network tab for API debugging, Console for frontend errors

---

## Troubleshooting

### "Claude doesn't follow CLAUDE.md conventions"

**Cause:** Claude's context window filled up and it forgot.

**Fix:** Say: "Please re-read CLAUDE.md Section 4 (Code Conventions) and Section 15 (Design System)."

### "Claude generated code that doesn't work"

**Cause:** Claude made an assumption that doesn't match your environment.

**Fix:** Paste the exact error message. Say: "This error occurs when I run [command]. Fix it."

### "Claude is too slow / times out"

**Cause:** You're asking for too much code at once.

**Fix:** Break into smaller chunks. "Just build the API routes first. Don't build the frontend yet."

### "I lost my work because Claude's context reset"

**Cause:** You didn't save/commit working code before starting a new feature.

**Fix:** Always commit after every feature. Use git as your safety net.

### "Tests pass but the UI looks wrong"

**Cause:** Claude followed logic correctly but ignored the design system.

**Fix:** Say: "The functionality works but the design doesn't match CLAUDE.md Section 15. Fix the styling to use the correct color tokens and spacing."

---

## Example: Complete Session for F0.1

Here's what a real session looks like from start to finish:

### You (Message 1):
```
I'm building Vexlyx, an open-source hybrid hosting control panel.

Before we start, please:
1. Read CLAUDE.md for project conventions, tech stack, and design system
2. Read the feature section for F0.1 — Monorepo Setup in FEATURES.md
3. Ask me any clarifying questions before writing code

Do NOT install new dependencies without asking me first.
Do NOT skip the planning phase.
```

### Claude (Message 2):
```
I've read both files. I have a few questions before we proceed:

1. Do you want pnpm workspaces or npm workspaces? CLAUDE.md mentions pnpm.
2. Should the root package.json include dev scripts that run all apps, or separate commands?
3. Do you want TypeScript project references between packages?

My proposed approach:
- Initialize Turborepo with pnpm
- Create three workspaces: apps/dashboard, apps/api, packages/shared
- Set up shared tsconfig, eslint, and prettier configs at root
- Configure turbo.json with build, dev, lint, and test pipelines

Shall I proceed with this plan?
```

### You (Message 3):
```
1. pnpm workspaces — yes
2. Root dev script should run all apps with turborepo
3. Yes, TypeScript project references

Proceed with the plan.
```

### Claude (Messages 4-8):
```
[Claude generates all the files for the monorepo setup]
```

### You (Message 9):
```
I see the files. Let me test them.
```

### [You run the tests in your terminal]

### You (Message 10):
```
All tests passed. pnpm install, pnpm dev, pnpm build, and pnpm lint all work correctly.

Now do these two things:
1. Update FEATURES.md — change F0.1 status from 🔴 NOT STARTED to 🟢 COMPLETED
2. Write developer documentation at docs/dev/monorepo-setup.md
```

### Claude (Messages 11-12):
```
[Claude updates FEATURES.md and writes docs/dev/monorepo-setup.md]
```

### You (Message 13):
```
Docs look good. I'll commit this now.
```

### [You commit and push]

### You (Message 14):
```
/clear
```

### [Start next feature...]

---

## Quick Reference Card

Keep this handy while coding:

| Action | Command / Prompt |
|--------|-----------------|
| Start feature | "Read CLAUDE.md and FEATURES.md F0.X, ask questions, then code" |
| Fix bug | "Feature F0.X has a bug: [describe]. Error: [paste]" |
| Refactor | "Refactor [file] to [goal]. Plan first, then implement." |
| Mark complete | "Tests passed. Update FEATURES.md and write docs/dev/[name].md" |
| Reset context | `/clear` |
| Check conventions | "Re-read CLAUDE.md Section 4 and 15" |
| Test everything | `pnpm typecheck && pnpm lint && pnpm build && pnpm test` |
| Commit | `git add . && git commit -m "feat(F0.X): [description]"` |

---

## Final Advice

1. **Be patient.** Vibe coding is fast, but rushing leads to technical debt. Test everything.
2. **Be specific.** "Make it look better" is vague. "Increase the card padding from p-4 to p-6" is actionable.
3. **Be consistent.** Always follow the same workflow. Don't skip the planning phase, don't skip tests, don't skip docs.
4. **Be the architect.** Claude writes code, but YOU decide the direction. If something feels wrong, stop and rethink.
5. **Ship early.** Phase 0 (7 features) is your MVP. Get it working, get it on GitHub, then iterate.

---

*This guide evolves as we learn what works. Update it when you discover better patterns. Last updated: 2026-08-28*
