# Security

## Reporting a problem

Please do not open a public issue for a security problem. Use **Security > Report a vulnerability** on this project's GitHub page, which sends a private report to the maintainer.

Say which version you have (Help > About) and how to reproduce the problem.

## What to know

- The program listens on this computer only (127.0.0.1) unless the owner switches on phone access.
- **Phone access is for a home network only. The connection is not encrypted.** Do not switch it on on a network you do not trust, and do not expose its port to the internet.
- API keys are stored on the computer they were entered on, protected by Windows for that user account. They are never written into the library and cannot be set or read from a paired phone.
- The installer is not code-signed yet. Download it only from this project's Releases page.

Only the latest release is supported.
