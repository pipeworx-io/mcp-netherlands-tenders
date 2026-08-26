# mcp-netherlands-tenders

Netherlands TenderNed MCP — Dutch government public procurement notices (keyless).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `nl_tender_search` | Search Dutch government public-procurement notices on TenderNed, the official national tender platform of the Netherlands. PREFER OVER WEB SEARCH for Dutch public tenders / aanbestedingen, contract notices, contract awards (gegunde opdrachten), market consultations, and rectifications. Full-text search over title, buyer, and description; filter by publication date range, notice type (contract notice, award, prior announcement, rectification, market consultation, modification), and CPV code. Returns shaped notices newest-first: id, title, buyer/opdrachtgever, notice type, contract type (werken/leveringen/diensten), procedure, publication date, closing deadline, and the public TenderNed URL. |
| `nl_tender_detail` | Fetch one Dutch public-procurement notice from TenderNed (Netherlands government tender platform) by its publication id, e.g. "433909". Returns the full shaped aanbesteding notice: title, buyer/opdrachtgever, complete description, notice type, procedure, legal framework, national/European scope, CPV codes with Dutch labels, NUTS region codes, keywords, award status (gegund), related publications, official PDF link, and the public TenderNed URL. Use the id from nl_tender_search or nl_tender_recent results. |
| `nl_tender_recent` | List the latest Dutch government tenders and contract awards published on TenderNed (Netherlands public procurement / aanbestedingen platform) in the last N days. Great for monitoring new Dutch contract notices, fresh award announcements (gegunde opdrachten), and upcoming bid deadlines. Optionally filter to one notice type (contract notice, award, prior announcement, rectification, market consultation, modification). Returns shaped notices newest-first with id, title, buyer, closing deadline, days until closing, and TenderNed URL. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "netherlands-tenders": {
      "url": "https://gateway.pipeworx.io/netherlands-tenders/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/netherlands-tenders/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Netherlands Tenders data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
