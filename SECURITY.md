# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately with a [private security advisory](https://github.com/goncalompontes/opencode-plugin-migrate/security/advisories/new).
Include the affected version or commit, reproduction steps, and impact.

You should receive a response within 7 days.

## Scope

This tool reads plugin source code and writes converted files. It never executes
plugin code, never sends source anywhere, and does not require credentials.
Reports about generated output that could expose secrets or execute unexpected
code are in scope.

## Supported versions

| Version | Supported |
| --- | --- |
| latest (0.1.x) | ✅ |
| older | best effort |

## Disclosure

Once a fix is released, the reporter is acknowledged in the release notes unless
anonymity is requested.
