# ADR-0001: Public unauthenticated Thangs import

- Status: Accepted — integration deferred beyond the MVP
- Decision date: 2026-07-21
- Task: M04
- Affects: post-MVP M05 only

## Context

The original MVP draft required a user to submit a public Thangs model URL and
have Yuki import the downloadable original files and public metadata without
authenticating to Thangs. The integration had to be both technically stable and
permitted. After this spike, the product decision was changed: manual file and
ZIP import is the MVP path and direct third-party imports are deferred.

This spike considered only interfaces and policies published by Thangs. It did
not inspect browser traffic, discover private endpoints, simulate credentials,
or attempt to bypass access controls. This record is an engineering risk
decision, not legal advice.

## Decision

Do not implement or release M05 against the currently observable Thangs website.
No stable, permitted, public unauthenticated metadata and file-download mechanism
could be established from Thangs' published materials as of the decision date.

M05 is removed from the MVP DAG. The Thangs importer must not be presented as
available in the MVP UI. Manual file and ZIP upload now satisfies the revised
MVP import scope.

The decision can be revisited only when at least one of these is obtained:

1. official, versioned Thangs documentation for a public integration that permits
   unauthenticated retrieval of model metadata and downloadable files, together
   with applicable usage and attribution terms; or
2. written authorization from Thangs covering Yuki's intended on-demand import
   behavior, plus a supported technical contract for metadata and file download.

## Evidence

All sources below are first-party Thangs publications and were accessed on
2026-07-21.

| Source | Relevant evidence | Assessment |
| --- | --- | --- |
| [Terms and Conditions](https://thangs.com/resources/legal/terms-and-conditions) | Use of the Platform is subject to the agreement; Thangs may change the Platform or terms at its discretion. The prohibited-behavior section bars unauthorized collection, including scraping, and the proprietary-rights section restricts attempts to derive underlying structure. | An undocumented browser endpoint is not a supportable integration contract. The public visibility of a page or URL does not itself authorize automated collection. |
| [Thangs Content Policy](https://thangs.com/resources/legal/content-policy) | The anti-scraping section states that automated scraping and bulk downloading are prohibited, and that commercial data harvesting violates the terms. | Automated page extraction is expressly unsuitable. Although Yuki would import on demand rather than crawl in bulk, no publication affirmatively authorizes that automation, so permission cannot be assumed. |
| [Thangs Help Center](https://thangs.com/resources/help-center) | Thangs describes a membership API for exclusive sellers and a custom API for professional designers. It does not document a generally available consumer model-discovery or file-download API. It also documents creator-controlled memberships, purchases, and download entitlements. | The published API offerings are targeted integrations, not a public unauthenticated download API. Model visibility does not imply that every file is freely downloadable. |
| [Representative public model page](https://thangs.com/designer/Mattias%20Hellberg/3d-model/Among%20Us-12446) | A public model page exposes presentation metadata and a `Download` action in the website UI. | This demonstrates a human-facing public page, not a documented programmatic metadata schema, durable download URL, service-level commitment, or permission for third-party automated retrieval. |

No official developer documentation, public API specification, versioning policy,
or terms specifically permitting the required third-party unauthenticated import
was found in the reviewed first-party material. This is an absence-of-evidence
finding, so it is intentionally treated as a blocker rather than as permission.

`robots.txt` is not used as evidence for this decision. Robots directives are
crawler hints, not an API contract or grant of legal permission; in any case, the
product needs affirmative support for downloading files, not merely permission to
index public pages.

## Technical findings

The public website does not provide the contract M05 needs:

- no published canonical URL grammar or redirect/canonicalization guarantees;
- no documented unauthenticated endpoint for title, creator, description,
  license, images, remote identifier, and the complete original-file set;
- no documented distinction between freely downloadable, account-gated,
  membership, and purchased models suitable for machine enforcement;
- no documented stable file identifiers, checksums, archive semantics, expiry,
  rate limits, error taxonomy, or compatibility/version policy;
- no stated attribution payload or rules for a third-party catalogue import.

Some public pages currently render metadata and a download control. Building on
their markup or the website's private requests would couple Yuki to an unstable
implementation detail and would conflict with the policy evidence above. It is
therefore out of scope even as a temporary adapter.

## Required behavior while blocked

- No Thangs importer or enabling deployment option is shipped in the MVP.
- A pasted Thangs URL may be recognized only to offer the ordinary manual-upload
  guidance; the application must not fetch the page or files server-side.
- User-facing copy must say that direct Thangs import is unavailable, without
  claiming that manual upload fulfills the Thangs requirement.
- If a supported integration is added later, network and provider failures must
  leave the import session failed with an actionable error and publish no partial
  model, as required by the architecture.
- A future adapter must reject paid, member-only, login-gated, ambiguous-license,
  or otherwise unauthorized content rather than attempt to obtain it.

## Conditions for a future M05

Once permission and a supported contract exist, M05 must still validate the
following before release:

- only canonical `https` Thangs model URLs are accepted;
- outbound requests use exact host allowlists, DNS/private-address checks,
  redirect revalidation, timeouts, response/member count limits, and byte limits;
- only the documented public endpoint and response fields are consumed;
- entitlement or authentication is never bypassed or simulated;
- remote identifiers and source URLs are retained, and creator, license, and
  attribution data are preserved verbatim where the supported contract provides
  them;
- originals enter the existing quarantine pipeline and catalogue publication is
  atomic;
- contract fixtures cover free, removed, gated, rate-limited, oversized,
  redirected, and provider-error cases;
- an operational kill switch can disable new Thangs imports without affecting
  local upload or already imported models.

## Consequences

The product avoids shipping a fragile scraper or relying on permission inferred
from public visibility. Local file and ZIP imports can continue independently.
M05 remains post-MVP work unless Thangs supplies the necessary permission and a
supported interface. The revised MVP and M06 cover manual file and ZIP import and
have no Thangs release gate.
