# Security Policy

Context Atlas analyzes source repositories and stores a local project-memory
database. A vulnerability can therefore expose sensitive paths or metadata,
weaken an integrity boundary, or cause a coding agent to trust corrupted
context. Please report security issues privately.

## Supported versions

| Version | Security status |
| --- | --- |
| `0.1.x` | Alpha; best-effort security fixes |
| `main` | Development branch; not a stable release |
| `< 0.1.0` | Not supported |

The `0.x` line is experimental software, not a hardened security product. Node
24 still labels the built-in SQLite API used by this release experimental. See
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) for the verified
scope and known gaps.

## Reporting a vulnerability

Use GitHub's **Security** tab and choose **Report a vulnerability** to open a
private security advisory. If private vulnerability reporting is not enabled on
the repository, ask the repository owner to enable it without including exploit
details in a public issue.

Do not disclose a suspected vulnerability in issues, discussions, pull
requests, screenshots, logs, or public test repositories before a coordinated
fix is available.

Include only synthetic or minimized data:

- affected version, operating system, Node.js version, and install method;
- vulnerability class and the trust boundary it crosses;
- minimal reproduction steps in a disposable repository;
- expected and observed behavior;
- impact and realistic attack prerequisites;
- whether the issue exposes secrets, permits non-loopback access, corrupts
  history, bypasses confirmation, or mislabels unsafe context as safe; and
- a suggested remediation, if you have one.

Never send real credentials, proprietary source code, an unredacted
`.context-atlas/` directory, or third-party personal data. Replace sensitive
values with unmistakably synthetic markers while preserving the structure
needed to reproduce the issue.

No fixed response or resolution time is promised while the project is
maintainer-limited. The report should remain private until the maintainers and
reporter agree that disclosure is safe.

## Security-sensitive areas

Reports are especially valuable when they involve:

- sensitive-path or secret-redaction bypasses;
- path traversal, symlink traversal, or unintended filesystem access;
- dashboard exposure beyond loopback, CSP bypass, or content injection;
- MCP mutation without explicit confirmation;
- proposal approval or false-authority boundary bypass;
- ledger, backup, export, or database integrity failure;
- unsafe deserialization or command/argument injection;
- dependency or release-workflow compromise; or
- context packs marked `safeToUse: true` despite a critical integrity failure.

## Operational guidance

Until the alpha is hardened:

- run the dashboard only on the default loopback address;
- treat `.context-atlas/` state, backups, and exports as potentially sensitive;
- keep the generated database and backups out of version control;
- inspect context-pack warnings before giving the pack to an agent;
- use disposable copies when testing untrusted repositories; and
- keep Node.js and package dependencies current.

Context Atlas is a navigation aid. It is not proof that a repository is safe or
that generated code is correct.
