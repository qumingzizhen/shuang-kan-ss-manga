from __future__ import annotations

import argparse
import re
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {
    "",
    ".css",
    ".env",
    ".example",
    ".html",
    ".js",
    ".json",
    ".md",
    ".mjs",
    ".ps1",
    ".py",
    ".rs",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}
IGNORED_EMAIL_DOMAINS = {"example.com", "example.org", "example.test"}
EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})", re.IGNORECASE)
CONTENT_PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b"),
    "OpenAI-style token": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "Windows user profile": re.compile(r"\bC:\\Users\\[^\\\r\n]+", re.IGNORECASE),
    "private workspace path": re.compile(r"\b[A-Z]:\\(?:漫画|AI\\Codex)(?:\\|\b)", re.IGNORECASE),
    "Unix user home": re.compile(r"(?:^|[\s='\"])/(?:home|Users)/[^/\s'\"]+", re.IGNORECASE),
    "known private email": re.compile(r"2874157373@qq\.com", re.IGNORECASE),
}
SENSITIVE_ASSIGNMENT_RE = re.compile(
    r"^\s*(?:[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[:=]\s*([^#\r\n]*)",
    re.IGNORECASE | re.MULTILINE,
)
SAFE_PLACEHOLDER_VALUES = {"", "change-me", "replace-me", "<change-me>", "null", "none"}


def git_bytes(*args: str) -> bytes:
    process = subprocess.run(
        ["git", *args],
        cwd=PROJECT_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if process.returncode:
        raise RuntimeError(process.stderr.decode("utf-8", errors="replace").strip() or "git command failed")
    return process.stdout


def tracked_files() -> list[str]:
    return [item.decode("utf-8", errors="strict") for item in git_bytes("ls-files", "-z").split(b"\0") if item]


def blocked_path_reason(relative: str) -> str | None:
    normalized = relative.replace("\\", "/")
    path = PurePosixPath(normalized)
    parts = {part.lower() for part in path.parts}
    if parts.intersection({".data", ".cache", ".tools", ".private", ".next", "node_modules", "target"}):
        return "local data/cache directory"
    name = path.name.lower()
    if name.startswith(".env") and name != ".env.example":
        return "environment file"
    if path.suffix.lower() in {".key", ".pem", ".p12", ".pfx", ".jks"}:
        return "credential/certificate file"
    if "cookie" in name or name in {"headers.local.json", "credentials.json", "secrets.json"}:
        return "credential-like filename"
    if normalized.startswith("docs/") and "render" in normalized.lower() and path.suffix.lower() == ".png":
        return "document render QA artifact"
    return None


def scan_text(label: str, text: str, issues: list[str], *, check_assignments: bool = False) -> None:
    for description, pattern in CONTENT_PATTERNS.items():
        if pattern.search(text):
            issues.append(f"{label}: {description}")

    for match in EMAIL_RE.finditer(text):
        email = match.group(0)
        domain = match.group(1).lower()
        if email.lower().endswith("@users.noreply.github.com") or domain in IGNORED_EMAIL_DOMAINS:
            continue
        issues.append(f"{label}: public email address ({email})")

    if check_assignments:
        for match in SENSITIVE_ASSIGNMENT_RE.finditer(text):
            value = match.group(1).strip().strip("'\"")
            normalized = value.lower()
            if normalized in SAFE_PLACEHOLDER_VALUES or value.startswith("${"):
                continue
            issues.append(f"{label}: hard-coded sensitive configuration value")


def scan_docx(path: Path, relative: str, issues: list[str]) -> None:
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            if "docProps/custom.xml" in names:
                issues.append(f"{relative}: custom document properties")
            for name in names:
                if not name.endswith(".xml"):
                    continue
                text = archive.read(name).decode("utf-8", errors="replace")
                scan_text(f"{relative}!{name}", text, issues)
                if re.search(r"\bw:rsid(?:R|RDefault|P|RPr|Del|Sect)?=", text):
                    issues.append(f"{relative}!{name}: Word revision session identifier")
            core = archive.read("docProps/core.xml").decode("utf-8", errors="replace") if "docProps/core.xml" in names else ""
            for property_name in ("creator", "lastModifiedBy"):
                match = re.search(rf"<(?:dc|cp):{property_name}[^>]*>(.*?)</(?:dc|cp):{property_name}>", core, re.DOTALL)
                if match and re.sub(r"<[^>]+>", "", match.group(1)).strip():
                    issues.append(f"{relative}: non-empty document {property_name}")
    except (OSError, zipfile.BadZipFile, KeyError) as error:
        issues.append(f"{relative}: unreadable DOCX ({error})")


def scan_git_identities(issues: list[str]) -> None:
    public_refs = git_bytes(
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads",
        "refs/tags",
    ).decode("utf-8", errors="replace").splitlines()
    public_refs = [ref.strip() for ref in public_refs if ref.strip()]
    if not public_refs:
        return
    identities = git_bytes("log", "--format=%ae%n%ce", *public_refs).decode(
        "utf-8", errors="replace"
    ).splitlines()
    for email in sorted({item.strip() for item in identities if item.strip()}):
        if not email.lower().endswith("@users.noreply.github.com"):
            issues.append(f"Public branch/tag history: non-private commit email ({email})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fail when the Git public snapshot contains local or sensitive data.")
    parser.add_argument("--skip-history", action="store_true", help="Skip commit identity checks while preparing a clean public history.")
    args = parser.parse_args()

    issues: list[str] = []
    warnings: list[str] = []
    files = tracked_files()
    for relative in files:
        reason = blocked_path_reason(relative)
        if reason:
            issues.append(f"{relative}: tracked {reason}")
            continue

        path = PROJECT_ROOT / relative
        if not path.is_file():
            continue
        size = path.stat().st_size
        if size > 50 * 1024 * 1024:
            issues.append(f"{relative}: file is larger than 50 MiB")
        elif size > 1024 * 1024:
            warnings.append(f"{relative}: file is larger than 1 MiB")

        suffix = path.suffix.lower()
        if suffix == ".docx":
            scan_docx(path, relative, issues)
        elif suffix in TEXT_SUFFIXES and size <= 10 * 1024 * 1024:
            text = path.read_text(encoding="utf-8", errors="replace")
            scan_text(relative, text, issues, check_assignments=suffix in {".env", ".example", ".yaml", ".yml"})

    if not args.skip_history:
        scan_git_identities(issues)

    for warning in sorted(set(warnings)):
        print(f"warning: {warning}")
    if issues:
        for issue in sorted(set(issues)):
            print(f"privacy error: {issue}", file=sys.stderr)
        raise SystemExit(1)

    print(f"public repository check passed ({len(files)} tracked files)")


if __name__ == "__main__":
    main()
