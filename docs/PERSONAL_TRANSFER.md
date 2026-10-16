# Personal-account transfer preparation

Staged destination: `mehrdadxzaker/radiodesk`. Repository ID: `1416246508`.
Keep this draft unmerged until its separately approved cutover. This preparation
does not transfer anything or change live service settings, App ownership,
Apple identities, DNS, deployments, or billing.

## Prepared changes

README/release links and the embedded Hamlib guide link use the destination.
Bridge instructions authorize `https://mehrdadxzaker.github.io` explicitly;
loopback binding and bridge origin/token checks are unchanged. The checked-in
single-file HTML was rebuilt from the locked dependencies and differs only in
the source-guide URL.

## Later cutover

The future site is `https://mehrdadxzaker.github.io/radiodesk/`. Update the
repository homepage and verify Pages source/permissions during the approved
cutover, then publish main through the existing guarded Pages job. Stop and
restart a user-owned local bridge with the new explicit origin when switching
the hosted app; do not widen its allowlist to arbitrary origins. No bridge,
radio, or transmitter is started here.

Old Pages addresses need a separately published organization-root redirect;
they are not covered by Git repository redirects. A prepared legacy Pages
bundle is included in the local transfer handoff. Do not recreate the
transferred repository slug to host it. Check the new site, saved standalone
HTML, bridge authentication, and an explicitly approved radio connection after
cutover. This branch does not publish a release or a site.

## Validation

`npm run typecheck`, `npm run build`, and `npm run verify`; compare the rebuilt
HTML with main to confirm only the guide URL changes. Build dependencies are
installed from the lockfile. Hardware integration is separate qualification.
