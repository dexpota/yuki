# ADR-0007: Generic webhook notifications

Status: accepted

## Context

Yuki requires one configurable external notification channel for print
completion, failure, cancellation, and active-job disconnect events. Delivery
must have no effect on print state, must survive restarts, and must not require a
hosted provider.

The channel accepts an owner-configured destination and therefore shares the
same untrusted-outbound concerns as printer endpoints: credentials in URLs,
redirects, DNS resolution, private addresses, timeouts, oversized responses,
and secret leakage.

## Decision

The MVP external channel is a generic HTTPS webhook behind the
`NotificationSender` port. Configuration is owner-scoped and contains:

- an enabled flag;
- one encrypted HTTPS URL without URL credentials, query, or fragment;
- an optional bearer token encrypted with the installation master key.

Destinations are resolved and checked when configured and immediately before
each send. Loopback, link-local, multicast, reserved, and private addresses are
rejected. Redirects are disabled. Requests time out after ten seconds and
response bodies are drained only up to 64 KiB.

The request body is `yuki.notification.v1` JSON containing the notification ID,
kind, timestamp, title, message, optional print-attempt/printer IDs, and bounded
facts already persisted with the notification. The bearer token, destination,
internal job state, and storage data are never included.

HTTP 2xx completes delivery. Timeouts, network failures, 408, 425, 429, and 5xx
responses are transient and use the durable job runner's bounded exponential
retry policy. Other responses and unsafe/invalid configuration fail
permanently. A disabled or unconfigured channel completes the outbox job as
skipped; it never changes the source notification or print attempt.

Each notification has one durable delivery diagnostic recording pending,
retrying, succeeded, failed, or disabled state, attempt count, sanitized error
code/message, response status, and timestamps. Secrets and response bodies are
never persisted.

## Consequences

- Deployments can integrate email, chat, automation, or other systems through a
  webhook receiver without Yuki depending on a provider.
- Private-network webhook receivers are outside the MVP security policy.
- Users can rotate or remove the bearer token without exposing the stored value.
- Delivery remains at-least-once across ambiguous network failures. Receivers
  should deduplicate by the stable notification ID.
