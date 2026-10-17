# Accounts and OAuth

## Google setup

1. Create a Google Cloud project and enable the YouTube Data API v3 and YouTube Analytics API. Enable the YouTube Reporting API if using reporting jobs.
2. Create an OAuth 2.0 Desktop application client.
3. Provide `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to the MCP process.
4. Authorize each channel under a distinct local alias:

   ```bash
   npm run auth -- personal
   npm run auth -- brand
   ```

   The script prints a consent URL. After approval, paste the `code` query parameter from the localhost redirect.

Each authorization uses its own refresh token and cached OAuth client. For Brand Accounts, complete a separate consent flow for each channel you intend to control and verify the resulting channel with `youtube_get_channel`.

## Account selection

Every YouTube tool accepts an optional `account` alias:

```text
youtube_get_channel({ account: "brand" })
```

When omitted, selection follows this order:

1. Per-call `account`.
2. `YOUTUBE_PLUGIN_ACCOUNT` (or the legacy `YOUTUBE_MCP_ACCOUNT`).
3. Saved default from `accounts_set_default`.
4. The only configured account.
5. Legacy `tokens.json` as the `default` account.

If multiple accounts exist and no default is set, the tool fails with the available aliases instead of guessing.

The account tools are `accounts_list`, `accounts_status`, `accounts_begin_auth`, `accounts_complete_auth`, `accounts_set_default`, and `accounts_remove`. `accounts_remove` requires `confirm: true`. `youtube_quota_status` reports estimated local usage, and `youtube_doctor` checks local configuration.

## Credential storage

The default path is `~/.config/youtube-plugin/`; override it with `YOUTUBE_PLUGIN_CONFIG_DIR` (or the legacy `YOUTUBE_MCP_CONFIG_DIR`). Tokens are stored separately at `accounts/<alias>.json`. Directories use mode `0700` and token files use mode `0600` on POSIX systems. Writes use a temporary file and atomic rename. Aliases are validated and never used as arbitrary filesystem paths.

If you are upgrading from the previous package and used its default `~/.config/youtube-mcp/` directory, either keep using that location by setting `YOUTUBE_PLUGIN_CONFIG_DIR="$HOME/.config/youtube-mcp"` or copy its `accounts/` directory and `default-account` file into `~/.config/youtube-plugin/`.

The legacy `YOUTUBE_MCP_ACCOUNT` and `YOUTUBE_MCP_CONFIG_DIR` environment variables remain supported as fallbacks. If you used a custom config directory, keep setting that path or update it to `YOUTUBE_PLUGIN_CONFIG_DIR`. The `YOUTUBE_PLUGIN_TOOLSET` variable controls tool registration; `YOUTUBE_MCP_TOOLSET` remains a compatibility fallback.

Existing `tokens.json` is read only as a migration fallback for the `default` alias. New token writes go to the config directory. The server does not write credentials to stdout or logs.

## Scopes

Default authorization requests:

- `youtube`
- `youtube.upload`
- `youtube.force-ssl`
- `yt-analytics.readonly`
- `yt-analytics-monetary.readonly`

Monetary reports additionally require YouTube Partner Program eligibility. Membership operations require the sensitive scope `youtube.channel-memberships.creator` and an eligible channel with memberships enabled. It is not requested by default. Opt in only if needed:

```bash
npm run auth -- brand --memberships
```

Or request it through `accounts_begin_auth` with `includeMembershipScope: true`. Existing stored tokens are not silently expanded; authorize again after opting in. `accounts_status` reports the granted scope list.

## OAuth app testing mode

Google OAuth apps in Testing mode can issue refresh tokens that expire after a short inactivity period. For a durable personal setup, configure the OAuth consent screen appropriately and reauthorize if refresh fails. Do not paste client secrets or refresh tokens into prompts or source files.
