# Security and privacy

Please report vulnerabilities through GitHub's private security-advisory feature.
Do not open a public issue containing cookies, request headers, access tokens,
downloaded content, private gallery URLs, or server credentials.

Before publishing or pushing a change, run:

```text
python scripts/check_public_repo.py
```

Runtime credentials belong in ignored local `.env` files or a deployment secret
manager. Files under `.data`, `.cache`, `.tools`, `.private`, source-auth folders,
and document-render QA folders must remain local.
