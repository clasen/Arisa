# arca-invoice

Version 0.2.1 supports a deliberately narrow fiscal flow: one Factura C for professional services, in ARS, consumer final without identification, below ARS 10,000,000. Other recipient types, currencies, notes and tax treatments are not implemented.

## Actions

Run `node index.js --help` or `node index.js run --request-file <json>` with ARISA_PACKAGE_DIR supplied by Arisa.

- inspect-certificate: local identity, dates, key match and key permissions.
- connectivity: unauthenticated FEDummy.
- read-status: WSAA authentication, point-of-sale list and last C invoice.
- prepare: args.draft JSON containing amount (fixed two decimals), date/from/to/due (YYYYMMDD), description `Servicios profesionales`, saleCondition `Contado`. Returns a content-addressed draftId. It does not issue.
- issue: args.draftId and args.approval must match the explicitly approved draft hash. Requires current Argentina date, same-day compliance review and printable issuer config. Validates point-of-sale status and recipient VAT condition before submission.
- reconcile: args.draftId. Queries FECompConsultar and matches sequence, dates, recipient, concept, amounts, currency and authorization. Never resubmits; also independently verifies an already authorized invoice.
- export-pdf: args.draftId, optional args.style=classic|modern, args.copies=original|all. Defaults to one original page in the modern design. Chat-scoped PDF_STYLE and PDF_COPIES override those defaults; invocation args override chat preferences. The all option adds duplicate and triplicate. Re-rendering an authorized invoice changes presentation only; it never requests another CAE. Registry materializes the PDF with QR as an artifact.

## Safety

Strict certificate and hostname verification, TLS >= 1.2 and request-local ECDHE AES-GCM/ChaCha20 cipher selection. No global TLS changes. Fixed official endpoints, no redirects, bounded responses and timeouts.

Credentials and tickets remain in chat-scoped state. Do not place them in tool source, inputs or logs. Environment-separated tickets are bound to the certificate fingerprint. Inspect-certificate is not a separate certificate chain/revocation audit.

Network actions use an exclusive chat/environment lock. Crash-retained locks require manual investigation, never automatic removal. Issue persists and fsyncs a submitting intent before the CAE call. Uncertain/submitting records block all further new issuance in that chat. A timeout, malformed response or uncertain result is never automatically retried. Rejected requests remain recorded and are not auto-retried either. Authorized replays return their existing receipt. Other software can still use the fiscal account: numbering conflicts stop rather than silently creating a different invoice.

Human authorization must cover the exact draft. The approval parameter is an execution gate for the agent, not independent authentication of human consent. Preserve source message references in chat state. Never manufacture a CAE or call a live invoice a simulation.

## Configuration

Defaults are generic. Set CUIT, POINT_OF_SALE, ENVIRONMENT and ISSUER_NAME/ADDRESS/IIBB/START through chat config. Keep credentials/arca-<environment>.key and .crt in chat tool state with protected permissions. COMPLIANCE_REVIEW_DATE must match the date of issuance; review the current official rule before setting it. The implemented threshold is not automatically updated when regulations change.

Official references:
- https://www.arca.gob.ar/fe/emision-autorizacion/datos-comprobantes.asp
- https://www.arca.gob.ar/fe/ayuda/documentos/wsfev1-RG-4291.pdf
- https://www.arca.gob.ar/fe/qr/documentos/QRespecificaciones.pdf

## Tests and limitations

`pnpm install --ignore-scripts`; `npm test`. Offline tests cover validation, exact approvals, no-resend after success/rejection/timeout, response mismatches, reconciliation, TLS policy and PDF generation. They are not homologation tests.

Operators should validate their own setup in homologation before production use. Mock tests do not establish fiscal correctness for every account or regulatory scenario. This tool does not cover operations outside the narrow supported flow. No scheduler or autonomous invoice creation is installed.
