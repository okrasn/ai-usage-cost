# Security policy

`ai-usage-cost` runs on your machine, reads the local logs of your AI coding tools and writes a self-contained HTML file. It has no server, no
account and no telemetry; the only network access is the optional daily download of the public price table.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's private vulnerability reporting on the repository
(Security → Report a vulnerability), or write to the maintainer at the address in `package.json`. You can expect an answer within a week.

## What is in scope

- The generated page executing text that came from your logs (project paths, session titles, branch names, model names).
- The installer or the generator writing outside the folders documented in the README, or running something it should not.
- A way to make the price download alter costs or run code.
- Data leaving the machine other than the price-table request.

## Good to know

- `history.json` and the generated `index.html` list your project paths, branches and session titles. They are created owner-only (`0600`);
  the eye button hides names on screen but the file still contains them, so share a screenshot, not the file.
- Only the latest `1.x` release is supported.
