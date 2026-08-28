# Installing a Context Atlas GitHub prerelease

Context Atlas is distributed as verified GitHub Release assets during the alpha
stage. The release workflow does **not** publish to the npm registry. Install the
`.tgz` archive directly and keep the checksum and SBOM beside it for verification.

These examples use the first planned release, `v0.1.0`. Replace the version in
all filenames and commands together for later releases.

## Expected assets

A complete release contains exactly these user-facing artifacts:

- `context-atlas-0.1.0.tgz` — npm-compatible package archive;
- `context-atlas-v0.1.0.sha256` — SHA-256 digests for the archive and SBOM; and
- `context-atlas-v0.1.0.spdx.json` — SPDX JSON software bill of materials.

GitHub also stores provenance attestations created by the release workflow for
the package archive and SBOM.

## Requirements

- Git;
- Node.js `>=24.12.0 <25`;
- npm; and
- GitHub CLI (`gh`) for the download and provenance commands below.

The supported runtime range is a tested contract, not a general Node 24 claim.
See [`RUNTIME_SUPPORT.md`](RUNTIME_SUPPORT.md).

## Linux

```sh
mkdir context-atlas-v0.1.0
cd context-atlas-v0.1.0

gh release download v0.1.0 \
  --repo moelomda/context-atlas \
  --pattern 'context-atlas-0.1.0.tgz' \
  --pattern 'context-atlas-v0.1.0.sha256' \
  --pattern 'context-atlas-v0.1.0.spdx.json'

sha256sum --check context-atlas-v0.1.0.sha256
gh release verify-asset v0.1.0 ./context-atlas-0.1.0.tgz --repo moelomda/context-atlas
gh release verify-asset v0.1.0 ./context-atlas-v0.1.0.spdx.json --repo moelomda/context-atlas
```

Both checksum lines must report `OK`, and both provenance commands must succeed.

## macOS

```sh
mkdir context-atlas-v0.1.0
cd context-atlas-v0.1.0

gh release download v0.1.0 \
  --repo moelomda/context-atlas \
  --pattern 'context-atlas-0.1.0.tgz' \
  --pattern 'context-atlas-v0.1.0.sha256' \
  --pattern 'context-atlas-v0.1.0.spdx.json'

shasum -a 256 --check context-atlas-v0.1.0.sha256
gh release verify-asset v0.1.0 ./context-atlas-0.1.0.tgz --repo moelomda/context-atlas
gh release verify-asset v0.1.0 ./context-atlas-v0.1.0.spdx.json --repo moelomda/context-atlas
```

Both checksum lines must report `OK`, and both provenance commands must succeed.

## Windows PowerShell

```powershell
New-Item -ItemType Directory -Path context-atlas-v0.1.0 | Out-Null
Set-Location context-atlas-v0.1.0

gh release download v0.1.0 `
  --repo moelomda/context-atlas `
  --pattern 'context-atlas-0.1.0.tgz' `
  --pattern 'context-atlas-v0.1.0.sha256' `
  --pattern 'context-atlas-v0.1.0.spdx.json'

Get-Content .\context-atlas-v0.1.0.sha256 | ForEach-Object {
  if ($_ -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
    throw "Malformed checksum line: $_"
  }
  $expected = $Matches[1].ToLowerInvariant()
  $file = $Matches[2]
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "Checksum mismatch for $file"
  }
  Write-Host "$file OK"
}

gh release verify-asset v0.1.0 .\context-atlas-0.1.0.tgz --repo moelomda/context-atlas
gh release verify-asset v0.1.0 .\context-atlas-v0.1.0.spdx.json --repo moelomda/context-atlas
```

The script must print `OK` for both files, and both provenance commands must
succeed.

## Install the verified archive

Use a new directory so the smoke test cannot accidentally resolve files from a
source checkout.

### Linux or macOS

```sh
mkdir installed-smoke
cd installed-smoke
npm init --yes
npm install --ignore-scripts ../context-atlas-0.1.0.tgz
npx context-atlas --help
```

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Path installed-smoke | Out-Null
Set-Location installed-smoke
npm init --yes
npm install --ignore-scripts ..\context-atlas-0.1.0.tgz
npx context-atlas --help
```

Expected result: the command prints the Context Atlas command reference without
requiring an initialized repository. Continue with the disposable workflow in
[`QUICK_START.md`](QUICK_START.md); do not use a private or employer repository
for first-run testing.

## What verification proves

- The SHA-256 check proves the downloaded bytes match the checksum asset.
- `gh release verify-asset` validates that the asset is covered by a GitHub
  Release attestation associated with the specified tag.
- The SPDX document inventories the packaged software; it is not a security
  certification.
- A successful install proves package structure and runtime startup for that
  environment, not correctness of an indexed project.

## Reporting an installation problem

Include only:

- release tag and package SHA-256;
- operating system and architecture;
- exact Node.js, npm, Git, and GitHub CLI versions;
- the command that failed;
- the exit code and secret-free error text; and
- whether checksum and provenance verification succeeded.

Never attach repository source, `.context-atlas/atlas.db`, credentials, private
paths, raw chat archives, or customer data to a public issue.

## Rollback and withdrawal policy

Release assets are treated as immutable evidence. A maintainer must not silently
replace an archive under an existing version.

1. **Broken artifact, correct source tag:** mark the release notes prominently,
   open a public incident issue, stop recommending the artifact, and publish a
   corrected patch version. Preserve the original release for traceability unless
   it contains sensitive material.
2. **Wrong commit or invalid release identity:** mark the release unusable,
   document the incident, remove distribution links, and publish a new version.
   Never move or recreate the same public tag to point at different source.
3. **Security or privacy defect:** stop promotion immediately, use a private
   security advisory when disclosure is not yet safe, remove exposed sensitive
   assets if necessary, and publish remediation and upgrade guidance.
4. **No npm-registry yank exists:** alpha releases are GitHub assets only. Any
   withdrawal action applies to the GitHub Release and its tag, not an npm
   package.

Every withdrawal or correction must leave an attributable public explanation
once disclosure is safe.
