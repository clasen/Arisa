# creator-scout

Search CreatorScout for YouTube and Twitch creators who cover comparable games or genres. The tool keeps one persistent browser profile per chat and can reveal a bounded number of public business emails.

## Actions

- `authenticate`: request a CreatorScout magic link and consume it through the optional `gmail-workspace` integration
- `status`: report whether the chat-scoped browser profile is signed in
- `search`: search creators by game or genre, with optional language and recency filters

For outreach research, use `requireExactReference=true` with `referenceTitles`. Rows that do not mention an exact title or verified localized alias are removed before any email lookup. Search output remains evidence for later provenance and deduplication review; it does not add contacts or send messages.

## State and credentials

The CreatorScout email is supplied through chat-scoped tool configuration. Browser session state is stored under the chat tool-state directory. Credentials, cookies, and magic links are never returned in tool output.

`gmail-workspace` is needed only for the `authenticate` action and is therefore not declared as a hard tool dependency. An already authenticated profile can run searches without Gmail.
