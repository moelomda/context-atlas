# Context Atlas Quick Start

This guide takes a clean source checkout to the first useful Context Atlas overview, context pack, and local dashboard. It uses a disposable Git repository so no personal or proprietary source is indexed.

> **Alpha status:** Context Atlas has not published its first GitHub release yet. These instructions run the source checkout. Use a current Node.js 24 maintenance release; the exact minimum supported Node.js version is being qualified in [issue #4](https://github.com/moelomda/context-atlas/issues/4).

## 1. Prerequisites

Install:

- Git;
- Node.js 24 or newer; and
- npm.

Check the tools:

```sh
git --version
node --version
npm --version
```

Do not continue with Node.js 22 or older. Context Atlas uses Node's built-in SQLite API.

## 2. Clone and build Context Atlas

The commands in this section work in PowerShell, Bash, zsh, and similar shells.

```sh
git clone https://github.com/moelomda/context-atlas.git
cd context-atlas
npm ci
npm run build
node dist/cli.js help
```

Expected result: the build completes and the final command prints the Context Atlas command list.

Running the complete test gate is recommended before contributing, but it is not required merely to explore the product:

```sh
npm run check
```

## 3. Create a disposable project

Keep the demo repository next to the Context Atlas checkout. It contains only synthetic text created by these commands.

### macOS, Linux, Git Bash, or WSL

From the `context-atlas` directory:

```sh
mkdir -p ../context-atlas-demo
cd ../context-atlas-demo
git init
git config user.name "Context Atlas Demo"
git config user.email "context-atlas-demo@example.invalid"
printf '# Demo service\n\nA small synthetic repository for evaluating Context Atlas.\n' > README.md
printf '{"name":"context-atlas-demo","private":true,"scripts":{"test":"node --test"}}\n' > package.json
git add README.md package.json
git commit -m "chore: create synthetic demo repository"
cd ../context-atlas
```

### Windows PowerShell

From the `context-atlas` directory:

```powershell
New-Item -ItemType Directory -Force ..\context-atlas-demo | Out-Null
git -C ..\context-atlas-demo init
git -C ..\context-atlas-demo config user.name "Context Atlas Demo"
git -C ..\context-atlas-demo config user.email "context-atlas-demo@example.invalid"
Set-Content -LiteralPath ..\context-atlas-demo\README.md -Value "# Demo service`n`nA small synthetic repository for evaluating Context Atlas."
Set-Content -LiteralPath ..\context-atlas-demo\package.json -Value '{"name":"context-atlas-demo","private":true,"scripts":{"test":"node --test"}}'
git -C ..\context-atlas-demo add README.md package.json
git -C ..\context-atlas-demo commit -m "chore: create synthetic demo repository"
```

Expected result: `context-atlas-demo` contains one commit and no private source or credentials.

## 4. Initialize project memory

### macOS, Linux, Git Bash, or WSL

```sh
node dist/cli.js init ../context-atlas-demo --name "Context Atlas Demo"
```

### Windows PowerShell

```powershell
node dist/cli.js init ..\context-atlas-demo --name "Context Atlas Demo"
```

Expected result: Context Atlas creates local state under the demo repository's `.context-atlas/` directory and reports the initialized repository.

Context Atlas does not retain full raw diffs or known sensitive files by default. Even so, use only repositories you are authorized to inspect and configure `.atlasignore` before indexing content that needs additional exclusions.

## 5. Inspect the project

### macOS, Linux, Git Bash, or WSL

```sh
node dist/cli.js overview --repo ../context-atlas-demo
node dist/cli.js health --repo ../context-atlas-demo
node dist/cli.js timeline --repo ../context-atlas-demo
```

### Windows PowerShell

```powershell
node dist/cli.js overview --repo ..\context-atlas-demo
node dist/cli.js health --repo ..\context-atlas-demo
node dist/cli.js timeline --repo ..\context-atlas-demo
```

Expected result:

- `overview` describes the indexed project without silently treating generated narrative as approved truth;
- `health` reports repository, database, ledger, freshness, and policy status; and
- `timeline` shows the synthetic commit history.

The demo is intentionally small, so unknown or empty knowledge areas are expected.

## 6. Generate a bounded context pack

### macOS, Linux, Git Bash, or WSL

```sh
node dist/cli.js pack "add a health-check endpoint" --json --repo ../context-atlas-demo
```

### Windows PowerShell

```powershell
node dist/cli.js pack "add a health-check endpoint" --json --repo ..\context-atlas-demo
```

Expected result: a bounded JSON context pack containing repository identity, warnings, evidence-linked knowledge, unknowns, and explicit exclusions. The pack is a navigation aid, not proof that a proposed change is correct.

## 7. Open the local dashboard

### macOS, Linux, Git Bash, or WSL

```sh
node dist/cli.js serve --repo ../context-atlas-demo
```

### Windows PowerShell

```powershell
node dist/cli.js serve --repo ..\context-atlas-demo
```

Open the loopback URL printed by the command, normally `http://127.0.0.1:4242`.

Expected result: the dashboard exposes the overview, project map, timeline, health information, search, and human review workspace. The server deliberately refuses unauthenticated non-loopback binding.

Stop the server with `Ctrl+C`.

## 8. Make a change and synchronize

Add a second synthetic commit in the demo repository, then update Context Atlas.

### macOS, Linux, Git Bash, or WSL

```sh
printf '\n## Health check\n\nThe service should expose an explicit health endpoint.\n' >> ../context-atlas-demo/README.md
git -C ../context-atlas-demo add README.md
git -C ../context-atlas-demo commit -m "docs: describe health endpoint"
node dist/cli.js sync --repo ../context-atlas-demo
node dist/cli.js overview --repo ../context-atlas-demo
```

### Windows PowerShell

```powershell
Add-Content -LiteralPath ..\context-atlas-demo\README.md -Value "`n## Health check`n`nThe service should expose an explicit health endpoint."
git -C ..\context-atlas-demo add README.md
git -C ..\context-atlas-demo commit -m "docs: describe health endpoint"
node dist/cli.js sync --repo ..\context-atlas-demo
node dist/cli.js overview --repo ..\context-atlas-demo
```

Expected result: synchronization records the new repository state and the next overview is bound to the updated snapshot. Human-reviewed guidance can still require a new review when its evidence boundary changes.

## 9. Clean up

Stop any running dashboard before cleanup.

### macOS, Linux, Git Bash, or WSL

```sh
rm -rf ../context-atlas-demo
```

### Windows PowerShell

```powershell
Remove-Item -LiteralPath ..\context-atlas-demo -Recurse -Force
```

This removes the disposable repository and its local `.context-atlas/` state. It does not modify the Context Atlas source checkout.

## Next steps

- Read the public [`ROADMAP.md`](../ROADMAP.md) for the path from alpha to production readiness.
- Choose a contribution path in [`CONTRIBUTOR_PATHS.md`](CONTRIBUTOR_PATHS.md).
- Review [`CONTRIBUTING.md`](../CONTRIBUTING.md) before opening a pull request.
- Read [`ARCHITECTURE.md`](ARCHITECTURE.md) before changing evidence, authority, time, persistence, MCP, or egress behavior.
- Report vulnerabilities privately through [`SECURITY.md`](../SECURITY.md), not through a public issue.
