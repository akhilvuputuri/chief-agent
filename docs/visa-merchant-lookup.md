# Visa Merchant Search: merchant MCC lookup

Chief can look up a merchant's MCC (merchant category code) in Visa's Merchant Search API. The tool is `merchant_mcc_lookup`: a read-only operation in the `subscriptions` tool domain, granted to the `core/subscriptions` agent (receipts, subscriptions and spending questions reach it through `agent_run`). It writes nothing to Visa or to the owner's data.

## What the API offers (read from the Visa reference, 2026)

The Visa developer page for Merchant Search embeds its OpenAPI spec (`https://developer.visa.com/api-reference/merchant_search`). The sandbox server is `https://sandbox.api.visa.com`. The owner's link names "Merchant Lookup v1 - Latest", which in that spec is `POST /merchantsearch/v1/merchantlookup`, titled "Transaction Lookup API". It takes a VisaNet `transactionId`, a `transactionDate` (YYYYMMDD) and a `transactionType` (`A` authorization, `C` clearing), not a name. The name-and-location operation is **Generic Search v2**, `POST /merchantsearch/v2/search`. Chief uses both through one tool:

- **By details** (the usual case): Generic Search v2 with `merchantName`, `merchantStreetAddress`, `merchantCity`, `merchantState`, `merchantPostalCode`, `merchantCountryCode` (3-digit ISO numeric), `merchantPhoneNumber` or `merchantUrl`. At least a name, URL or phone number is required. `maxRecords` is 1 to 10 (default 5).
- **By transaction**: Transaction Lookup v1 with `transaction: {transactionId, transactionDate, transactionType}`, for a Visa transaction whose VisaNet ID the owner has.

Each result gives `mcc` (primary), `allMccs`, `mccDescriptions`, `categoryGroup`, the merchant's name, store, brand and address, `matchScore`, `confidenceScore`, `confidenceRange`, name and address similarity and `matchIndicators` (search only; the lookup returns no scores). Visa does not pair descriptions with codes one-to-one, so Chief does not either.

Result statuses: `ok` (with `mccDiffers` when several records disagree), `no_match`, `busy` (429 or 503; honours `Retry-After`, and later calls inside that window are answered without calling Visa), `timeout` (15 seconds), `unreachable` (connection or certificate failure), `refused` (HTTP 4xx/5xx or a Visa status code other than `...000`, with the code and description). Sandbox results carry a note saying they are test data.

## Assumptions (not confirmed by the documentation)

The published spec does not list authentication, error codes or no-match behaviour. The implementation assumes, from how Visa Developer APIs usually work:

- Two-way SSL (client certificate and key) plus HTTP Basic auth with the project user ID and password. Message Level Encryption is **not** implemented; if the project requires it, requests will be refused and MLE must be added.
- The production host is `https://api.visa.com`.
- The response group in `responseAttrList` is `GNSTANDARD3` (the spec's example); Visa assigns the real group at onboarding, so `VISA_RESPONSE_GROUP` overrides it.
- A status code ending in `000` (`CDI000`, `API000`) is success. A non-success code whose description says no merchant, match or record was found is treated as `no_match`; any other is `refused` with its code shown. Verify against the sandbox and tell the owner of any code worth mapping.
- Responses may be wrapped in `merchantSearchServiceResponse` (as in the example) or not (as in the schema); both are read.

## Operator setup

Nothing is needed for Chief to run: without credentials the tool is not offered, and a direct call says it is not configured. To enable it, set these in the private `.env` on the host (all values stay there; never commit them):

| Variable                                      | Meaning                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `VISA_USER_ID`, `VISA_PASSWORD`               | Basic auth credentials of the Visa Developer project. Required.                                         |
| `VISA_CLIENT_CERT` or `VISA_CLIENT_CERT_FILE` | Client certificate (PEM). Required; inline with `\n` for newlines, or a path readable in the container. |
| `VISA_CLIENT_KEY` or `VISA_CLIENT_KEY_FILE`   | Private key (PEM). Required; same two forms.                                                            |
| `VISA_KEY_PASSPHRASE`                         | Only if the private key is encrypted.                                                                   |
| `VISA_CA_CERT` or `VISA_CA_CERT_FILE`         | Visa's CA bundle (PEM), if the system trust store does not cover Visa's server certificate.             |
| `VISA_MERCHANT_ENV`                           | `sandbox` (default) or `production`.                                                                    |
| `VISA_RESPONSE_GROUP`                         | Response group Visa assigned, default `GNSTANDARD3`.                                                    |

Setting only some of the four required values, both forms of one PEM, or an unreadable `*_FILE` leaves the tool off and logs one `merchant.visa_disabled` warning at startup (reason `incomplete` or `unreadable`, never a value); the gateway still starts. The `*_FILE` forms need the file mounted into the gateway container, which is a further Compose change; the inline form needs none.

## Rollout on merge (owner steps)

- **Compose:** `compose.yaml` gains eight gateway environment names (the `VISA_*` variables above, names only). The release pipeline refuses Compose changes, so run [`scripts/deploy-visa-merchant.py`](../scripts/deploy-visa-merchant.py) (tested by `scripts/test-deploy-visa-merchant.py`, modelled on `deploy-singapore-keys.py`) as the reviewed operator procedure in [cloud development](cloud-development.md). Its `BASE` is the commit this change was built on: confirm the live `RELEASE` first and add its SHA to `BASES` after review if another release landed. The values stay optional; the script never reads `.env`.
- **Database:** none. **Config files:** none; `plugins/core` and `plugins/registry.json` changed together with the new content hash.
- **Order:** add the Visa values to the host `.env` first (the tool stays off until all four required values exist), then roll out. Start on `sandbox`; switch `VISA_MERCHANT_ENV` to `production` only with production credentials.
- No live Visa call is made by any test.

## Open decisions for the owner

You asked for a plan and approval first; this flow had none, so these were decided by the implementation and are listed for you to confirm: using Generic Search v2 for name searches (the linked Transaction Lookup needs a VisaNet transaction ID and is also supported); two-way SSL plus Basic auth without MLE; the production host; the `GNSTANDARD3` response group; and the status-code heuristics above.
