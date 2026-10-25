# Security Policy

This policy covers the GCDIS championship platform: the public site
(`www.gcdis.in`), the team portal, the staff console (`admin.gcdis.in`) and the API
(`api.gcdis.in`), together with the code in this repository.

## Reporting a vulnerability

Please report suspected vulnerabilities privately by email to
**gcdisgalgotias@gmail.com** with the subject line `SECURITY: <short summary>`.
Do not open a public issue, pull request or discussion for a security problem.

Please include:

- the affected URL, endpoint or file, and the version or commit if known;
- the steps needed to reproduce the problem, with a proof of concept where possible;
- the impact you expect (for example data exposure, privilege escalation, payment
  tampering);
- how you would like to be credited, if at all.

The same contact is published in machine-readable form at
`https://www.gcdis.in/.well-known/security.txt` (RFC 9116).

## What to expect

| Step | Target |
| --- | --- |
| Acknowledgement of your report | within 3 working days |
| Initial assessment and severity | within 7 working days |
| Fix or mitigation for critical and high severity issues | within 30 days |
| Notification when the issue is resolved | when the fix is deployed |

We will keep you informed of progress and may ask for further detail. If we decide
that a report is not a vulnerability, we will explain why.

## Safe harbour

We will not pursue legal action against anyone who, in good faith:

- tests only against accounts they own or are authorised to use;
- avoids privacy violations, data destruction and service disruption (no denial of
  service, spam, social engineering or physical attacks);
- does not access, change or keep data belonging to other users beyond the minimum
  needed to demonstrate the problem, and deletes any such data afterwards;
- does not make or alter real payments; use the Razorpay test mode where available;
- gives us reasonable time to fix the issue before disclosing it publicly.

## Scope

In scope: the hosts listed above and the source code in this repository.

Out of scope: third-party services (Razorpay, Google sign-in, email providers),
findings that require a compromised device or browser, missing best-practice headers
without a demonstrable impact, rate-limit findings without a security impact, and
reports produced only by automated scanners without verification.

## Supported versions

Only the version currently deployed to production (the `main` branch) receives
security fixes.

## For maintainers

Operational security procedures are documented in:

- [docs/security/production-checklist.md](docs/security/production-checklist.md):
  secrets, payments, email, malware scanning, access control, monitoring and the
  incident response procedure;
- [docs/security/backup-and-restore.md](docs/security/backup-and-restore.md):
  backups, recovery objectives and the monthly restore drill.
