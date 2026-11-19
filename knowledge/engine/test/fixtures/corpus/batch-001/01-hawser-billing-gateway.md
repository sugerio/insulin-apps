# Hawser Billing Gateway

Hawser is the billing gateway that sits between the product services and the payment processors. It is owned by the Ledgerline team.

## Network

Hawser listens on port 8443 and only accepts mutual TLS connections from services registered in the service catalog. Plain HTTP is rejected at the load balancer.

## Retries and limits

Outbound calls to a payment processor are retried 3 times with a 250 millisecond backoff that doubles on each attempt. Each calling service is rate limited to 1,200 requests per minute. Requests above the limit receive HTTP 429 with a Retry-After header.

## Ownership

Pages for Hawser go to the Ledgerline on-call. Schema changes to the invoices table need approval from the Ledgerline tech lead.
