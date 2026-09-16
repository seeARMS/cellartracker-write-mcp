# Observed website protocol

Inspected on 2026-09-16 using an authenticated browser and the website's publicly served JavaScript. This is a description of an observed website implementation, not an official API specification.

## Inventory

`GET https://www.cellartracker.com/list.asp?table=Inventory&Page=N`

The reader uses `#main_table tr` rows with `input[name=iInventory]`. Numeric checkbox values are inventory IDs. The displayed barcode may have a leading zero; writes use the checkbox value. Location/bin come from `span.loc` / `span.bin` in the cell containing `span.bar`. Wine name comes from `td.name h3`.

`#top_gotolink` provides current/total pages. The “In My Cellar (N bottles)” link supplies the expected total. A header link to `user.asp?iUserOverride=…` supplies the account identity. Missing or inconsistent markup fails closed. Inventory reads deliberately do not use the site’s sticky filters or aggregated wine exports.

## Relocation

`GET /popup/relocate_form.asp` exposes `form#bulk_popup_form`, with `method=post`, `action=relocate.asp` and fields:

- `searchId` and `UISource`: empty in the inspected workflow
- `SetLocation`: destination, or the website's `(use current)` sentinel
- `SetBin`: destination, or the same sentinel
- `Bin_delete=on`: explicitly clears the bin

The public submit handler builds a URL from the popup fields, and POSTs serialized selected fields from `#bulkform`. The wrapper follows that division:

```http
POST /relocate.asp?searchId=&UISource=&SetLocation=Example+cellar&SetBin=24
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest

BulkAction=&iInventory=111111111&iInventory=222222222
```

These IDs are synthetic. The website uses `serializeLatin`, based on JavaScript `escape`: Latin-1 code points are percent encoded; most characters above 255 are converted to decimal HTML entities first (the observed implementation special-cases code point 381). The companion mirrors this encoding, including the site's UTF-8 content-type header. Unicode behavior is covered by contract tests but still requires live verification.

The site considers `<error>` elements in its XML response failures. The wrapper additionally requires inventory read-back to establish success; a successful HTTP response is not enough.

## Consumption

`GET /popup/consume_form.asp` exposes `form#bulk_popup_form`, with `method=post`, `action=bulkconsume.asp`, and fields `Consumed`, `iConsumptionType`, `ConsumptionNote`, `Revenue`, `RevenueCurrency`, and `WriteTN`. The wrapper validates this contract before submitting. It reads the form's currency, leaves revenue empty, and omits `WriteTN`.

```http
POST /bulkconsume.asp?Consumed=9%2F15%2F2026&iConsumptionType=1&ConsumptionNote=Dinner&Revenue=&RevenueCurrency=USD
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest

BulkAction=&iInventory=111111111
```

The same `serializeLatin` encoding applies. Supported disposition values are 1 through 14; value 0 (permanent deletion) is excluded. This example uses synthetic data.

Verification reads every page of `/list.asp?table=Consumed&Page=N`, validates totals and account identity, and matches original bottle IDs from `bottlehistory.asp?iBottle=…` links to `iConsumed` record IDs. For matching bottles, `GET /editconsumed.asp?iWine=…&iConsumed=…` reads the existing form without submitting it. Its `ConsumptionType`, `ConsumptionDate`, and `ConsumptionNote` fields provide exact recorded details. A bottle must be absent from current inventory and have one matching history record with the requested date, reason, and note to count as successfully consumed.

Inventory rows also expose the exact wine ID via `wine.asp?iWine=…` and bottle size via `span.siz`; these support unambiguous quantity selection. Both history and detail parsing were verified live against existing records. Consumption submissions have only been tested with synthetic responses.

## Browser transport

A plain unauthenticated HTTP fetch was rejected with HTTP 405 during development. That result did not establish that authenticated requests would fail: a subsequent direct Node.js request with the existing session cookies succeeded, and full inventory pagination was verified. Cookie authentication is now the default when configured. The optional browser companion performs same-origin requests from an existing signed-in tab. It does not bypass challenges: if CellarTracker requires sign-in or a browser challenge, the user must complete the normal site flow.

The extension polls an authenticated loopback HTTP server. Jobs have unique IDs and deadlines, and are delivered at most once. The server rejects non-loopback Host headers and web-page Origins. The extension validates operation shape independently and constructs paths itself. Neither side accepts a general URL or arbitrary script from an MCP tool argument.

No live relocation or consumption was performed merely to inspect the forms. End-to-end live write validation remains a release gate.
