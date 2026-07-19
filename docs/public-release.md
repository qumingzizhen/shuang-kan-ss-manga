# Public repository privacy boundary

The Git repository contains source code, public documentation, sanitized example
configuration, and the generated tag translation database. It must not contain
runtime or operator data.

## Local-only data

- `.env*` except `.env.example`
- `.data/` downloads, task snapshots, reader sessions, exports, and source auth
- `.cache/`, `.tools/`, `.runtime/`, build outputs, and dependency folders
- `.private/` local history bundles or other private backups
- Cookie, header, certificate, and private-key files
- Word/PDF render QA images under `docs/*render*`

## Before a public push

1. Put real deployment secrets in a local `.env` file or secret manager.
2. Run `python scripts/check_public_repo.py`.
3. Run `scripts/check.ps1` for the complete project validation.
4. Confirm `git status --short` contains only intentional source changes.
5. Push only the sanitized public branch; never push a local history bundle.

The public checker scans tracked filenames, text files, DOCX XML/metadata, large
files, common secret formats, local machine paths, and Git commit email addresses.
Commit identities must use a `users.noreply.github.com` address.
