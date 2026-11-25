# Agent sign-up and payment

An AI agent can open a Vivideo account, sign in, and buy plans or credits from the CLI or the MCP server. **The Stripe payment page is the only step a person has to do.** Everything else (starting the sign-up, waiting for payment, saving the API key, signing in to an existing account) runs from the CLI or MCP tools.

These routes are on the V3 API: `https://v3.api.vivideo.ai` by default. Override it with `--v3-base-url` or `VIVIDEO_V3_BASE_URL` (for example, for staging).

## Which flow?

| Situation | CLI | MCP tools |
|---|---|---|
| New email, no account | `vivideo signup --email E --plan pro\|max --period weekly\|yearly` | `start_signup` → show the link → `get_signup_status` |
| The email already has an account | `vivideo login --email E` (then `--code`) | `request_login_code` → ask the user for the code → `verify_login_code` |
| You already have a key | nothing to do; the key is the login | nothing to do |
| Buy a plan or credits later | `vivideo checkout --plan … --period …` or `--credits N` | `start_checkout` → show the link → `get_checkout` |

Paying never opens an existing account. Stripe does not prove who owns an email, so an existing account always needs the 6-digit code from its inbox.

## New account: pay first (CLI)

```bash
vivideo signup --email ada@example.com --plan pro --period weekly --open
# Pay here (Stripe, the only step that needs a person):
#   https://checkout.stripe.com/c/pay/cs_live_…
# Waiting for payment… polling every 10 s, up to 30 min. Ctrl-C is safe; resume with: vivideo signup status co_… --wait
# … pending
# … ready
# ✓ Paid. Account created for ada@example.com.
# plan: pro  credits: …
# API key saved to ~/.vivideo/config.json (owner-only, never printed).
```

- `--open` opens the payment page in the default browser.
- `--key-name NAME` names the key `Agent: NAME`.
- `--timeout SEC` sets the longest wait (default 1800). Polling is every 10 s at most.
- **Agents:** run `vivideo --json signup … --no-wait`, show `checkout_url` to the user, then run `vivideo --json signup status <checkout_id> --wait`. Without `--no-wait`, `--json` writes one early `{"event":"checkout_created", "checkout_url", …}` line to **stderr**, so you can show the link while stdout waits for the final result.

What can happen:

| Result | Meaning | Exit |
|---|---|---|
| `ready` | Paid; the account was created; the key is saved. | 0 |
| `account_exists` (409 from the start call) | The email already has an account. The CLI sends a code and asks for it in a terminal. Otherwise it prints `vivideo login --email E --code <6-digit code>` to run. | 13 |
| `needs_code` | The email got an account between start and payment. The plan went to that account. Same code flow as above. | 13 |
| `claimed` | The key was already handed out (it is returned only once). Sign in with `vivideo login` if it is lost. | 13 |
| `expired` / `failed` | The payment did not complete. Start again. | 14 |
| still `pending` at the timeout | Not paid yet. Resume with `vivideo signup status <id> --wait`. | 8 |

The **claim token** from the start call is the only way to the key. The CLI stores it in `~/.vivideo/claims.json` (`0600`) and never prints it. `signup status` reads it from there, or from `--claim-token` / `VIVIDEO_CLAIM_TOKEN` if the sign-up started on another machine.

## Existing account: email code

```bash
vivideo login --email ada@example.com            # sends a 6-digit code; prompts for it in a terminal
vivideo login --email ada@example.com --code 123456   # non-interactive: finish with the code
```

Each sign-in creates a **new** key named `Agent: <key_name>`. The account owner gets an email about it and can revoke it in Settings → API keys. `vivideo login` without `--email` still stores a key you already have, the same as `vivideo configure`.

## Buying later: checkout (needs a key)

```bash
vivideo checkout --plan max --period yearly        # plan
vivideo checkout --credits 500                     # credit top-up (needs a plan)
vivideo checkout status <checkout_id> [--wait]     # pending | paid | expired | failed
```

`checkout` sends an `Idempotency-Key`, so a retry returns the same checkout. Pass `--idempotency-key` to reuse one across runs. Exit codes: `0` paid, `14` expired or failed, `8` still pending at the timeout, `6` plan required (credits on a free account), `11` a conflict such as an existing subscription.

## MCP

The stdio server (`@vivideo/mcp`) has the same flow as tools. `start_signup`, `get_signup_status`, `request_login_code` and `verify_login_code` work **without** `VIVIDEO_API_KEY`. `start_checkout` and `get_checkout` need a key.

1. `start_signup {email, plan, period}` → show `checkout_url` to the user.
   - Error `account_exists` → go to step 3.
2. `get_signup_status {checkout_id, wait_seconds?}` (max 300 s per call; at most one poll per 10 s).
   - `ready`: the key is saved to `~/.vivideo/config.json` and every tool uses it at once. The key is never in the result.
   - `needs_code`: go to step 3.
3. `request_login_code {email}` → ask the user for the 6-digit code → `verify_login_code {email, code}`.
4. Later: `start_checkout {plan, period}` or `{credits}` → show the link → `get_checkout {checkout_id, wait_seconds?}`.

The server keeps claim tokens in memory and in `~/.vivideo/claims.json` (`0600`), so a restart does not lose a pending sign-up. Tool results never contain a claim token or an API key.

## Security

- **Keys:** stored in `~/.vivideo/config.json` (`0600`), never printed, never returned by a tool. If `VIVIDEO_API_KEY` is set, it overrides the saved key; the CLI warns about this.
- **Claim tokens and login codes** are redacted from every log line, error and output, like keys. They are never put in a URL.
- **Polling** is at least 10 s apart with a hard timeout, so an agent loop cannot flood the API.
- **Retries:** status reads and `checkout` (which has an Idempotency-Key) retry transient failures. `signup`, sending a code and verifying a code retry only a short 429. A 429 is a refusal made before any work, so a retry never sends a second code, creates a second key or opens a second payment session.
