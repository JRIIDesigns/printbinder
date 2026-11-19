# Code signing policy

> Draft. PrintBinder's installer is not signed yet. This page says how it will be signed once the project has been accepted by the SignPath Foundation, and what the rules are. Until then the installer shows Windows' "unknown publisher" warning (README, Installing).

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## What is signed, and from what

Only the Windows installer of a release, `PrintBinder-Setup-<version>.exe`, is signed.

Every signed installer is built by the workflow in [`.github/workflows/release-build.yml`](../.github/workflows/release-build.yml), on a machine run by GitHub, from the source in this repository at the release's tag and from nothing else. The libraries it includes are the open-source packages named in `package-lock.json`; their licences are in `THIRD-PARTY-NOTICES.txt`. Nothing built on a person's own computer is signed.

Each release is approved for signing by hand, by an approver named below. A release is published by a person, never by the build.

## Who does what

| Role | What it means | Who |
| --- | --- | --- |
| Authors | May change the source without another person's review | The [owners of the JRIIDesigns organisation](https://github.com/orgs/JRIIDesigns/people) |
| Reviewers | Look at every change offered by someone else (a pull request) before it is taken in | The same owners |
| Approvers | Approve each request to sign a release | The same owners |

Everyone in these roles uses two-step sign-in for GitHub and for SignPath.

Changes from anyone else come in as pull requests and are read by a reviewer before they are merged ([CONTRIBUTING.md](../CONTRIBUTING.md)).

## Privacy

PrintBinder has no account and no server of its own, and collects nothing about its users or their libraries. What it sends, and when:

- **Looking for an update.** At start, and when Check for updates is chosen, it asks the place its releases are published (GitHub) whether a newer version exists. The request says nothing about the user or the library.
- **AI features**, only if the user entered their own key, and only when they press a button or send a message: preview pictures, names, descriptions and facts read from files go to the company whose key was entered. Model files are never sent.
- **Find models online**, only if the user opens it: it is a web browser, and the sites visited in it see what any website sees.
- **Feedback**, only if the user sends it, through their own email program.

The full statement is in the program under Help > Privacy, in the [README](../README.md#privacy), and on the [website](https://jriidesigns.com/printbinder/).

## Installing and removing

The installer installs for the current Windows account only and changes nothing in the user's folders. PrintBinder is removed through Windows Settings > Apps; the user's library is never touched.

## Reporting a problem with a signed file

If you believe a file signed for this project is not what it should be, see [SECURITY.md](../SECURITY.md).
