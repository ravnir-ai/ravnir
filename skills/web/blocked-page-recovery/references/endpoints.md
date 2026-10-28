# Endpoints for blocked-page recovery

Exact calls. `web_fetch` on each of these returns text; parse the JSON or the XML as text.

## Wayback Machine

Check for a snapshot:

```
https://archive.org/wayback/available?url=<url-encoded address>
```

Answers with `{"archived_snapshots": {"closest": {"url": ..., "timestamp": "20260315", "available": true}}}`.
No `closest` means no snapshot.

Read a snapshot:

```
https://web.archive.org/web/<timestamp>id_/<url>
```

The `id_` suffix asks for the original bytes without the Wayback toolbar injected. Without it,
the page arrives with a banner and rewritten links, which is fine for reading and bad for parsing.

Newest snapshot of a page in the last two years (CDX index, one line per snapshot):

```
https://web.archive.org/cdx/search/cdx?url=<url>&from=20240101&output=json&limit=-1&filter=statuscode:200&collapse=timestamp:6
```

`limit=-1` returns the last line first when combined with `collapse`; if the answer looks reversed,
take the highest timestamp yourself. `statuscode:200` drops redirects and errors.

## archive.today

Same snapshot, four domains, in this order:

```
https://archive.ph/newest/<url>
https://archive.md/newest/<url>
https://archive.li/newest/<url>
https://archive.is/newest/<url>
```

A 200 with a page means a snapshot exists; a redirect to a search or submit form means none does.
The final URL carries the snapshot id, which is what you cite.

## Machine shapes on the same host

Try, in this order, and stop at the first that answers with real data:

- `/feed`, `/rss`, `/rss.xml`, `/atom.xml` — XML, often full text for blogs
- `/wp-json/wp/v2/posts?search=<term>` — WordPress sites, `content.rendered` holds the article
- `/api/...` — read the page's own HTML for `fetch(` / `axios(` / `graphql` calls
- `/sitemap.xml` — tells you what exists, not what it says

A JSON body that mirrors the page is the strongest source you can get: it is the publisher's own
data, live, with no wall in front of it.

## Response smells

| Body starts with | It means |
|---|---|
| `<!DOCTYPE html>` and under ~600 bytes | A redirect stub or a challenge page |
| `<html` with `cf-browser-verification` or `challenge-platform` | Cloudflare challenge |
| `{"error"` or `{"message":"Forbidden"` | The API is blocked too; move down the ladder |
| XML with `<rss` or `<feed` | A feed; the article text may be in `<content:encoded>` |

## What not to script

Do not write a loop that retries the original URL with different headers. A user agent does not
change what the server's network is, and the owner's browser is the only real second identity
here — which is step 4, `browser_open`, or `ask_user`.
