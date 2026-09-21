# Integrations

An integration is a saved OAuth connection to a service the user has an account with: Google (Calendar, Gmail), Linear, Notion, GitHub. You can spend its access token, and you can never read one.

```ts
export default async function main({ calendarId }) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
    { headers: { authorization: "Bearer {{integration:google}}" } },
  );
  return await response.json();
}
```

`{{integration:id}}` works like `{{secret:name}}`: the host substitutes it in the URL, any header and the body, and only for the hosts that integration was approved for. If the access token is about to expire, the host refreshes it first, so your code never deals with expiry.

Start with `kody.integrationList()`. It gives you each id, its status, its scopes and its approved hosts, and no tokens.

## When there is nothing in the list

An empty `integrationList` means no provider is set up, not that the user has no account. local-kody ships presets for Google, Linear, Notion and GitHub, and `search({ entity: "integration-preset:google" })` gives you the exact steps to relay: where to register the OAuth app, which client type and callback URL that provider needs, the default scopes, and the `npm run integration -- add` command with them filled in.

Relay those steps and stop. Registering an OAuth app is the user's, and getting the client type or the callback wrong is the usual way this fails. Get the scopes right before they register, too: widening them later means approving again.

For a provider with no preset, they also need `--auth-url`, `--token-url` and `--host`.

## Connecting one

`status: "not_connected"` or `"needs_reconnect"` means there is nothing to spend yet. Call `kody.integrationStart({ id })`. It returns an authorize URL and opens it in the user's browser.

**You cannot finish this step.** Someone has to click "Allow". Tell the user that, hand them the URL in case the browser did not open, and stop. When they say they are done, call `kody.integrationList()` again: the status is `connected`, or `lastError` says what went wrong. The window is five minutes.

## When something is missing

Errors name the next step, and the step is usually the user's:

- `No integration "google"` — nobody has configured the provider. The user registers an OAuth app with that service, then runs `npm run integration -- add google --client-id <id> --client-secret <secret>`. You cannot do this for them.
- `is not approved for host <host>` — the connection exists but not for that API host. `npm run integration -- allow <id> <host>`.
- `is not connected yet` / `needs reconnecting` — call `integrationStart` and ask for an approval.

## Scopes

An integration is configured with a set of scopes, and its token can only do what those cover. If an API returns 403 for a scope reason, do not retry: say which scope is missing and that reconnecting with it is the fix. `kody.integrationStart({ id, scopes })` can ask for a wider set, but the user has to approve again.
