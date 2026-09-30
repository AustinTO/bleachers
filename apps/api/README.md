# Bleachers API

The Worker uses D1 for game, event, moment, and media indexes; a Durable Object
for current game state; and R2 for H.264 replay segments. Before deploying the
archive feature to an environment, provision `bleachers-media` in that Cloudflare
account and apply migrations `0003_organizer_secret.sql`,
`0004_media_segments.sql`, and `0005_moment_media_time.sql` in order. The R2 binding is declared in
`wrangler.jsonc`.

```bash
npx wrangler r2 bucket create bleachers-media
npx wrangler d1 migrations apply DB --remote
```

For local verification, `npx wrangler d1 migrations apply DB --local` and
`npx wrangler dev` use local D1 and R2 state. Media uploads require the organizer
Bearer secret. Video segments are stored for the life of the bucket; configure
an R2 retention policy before sustained production use. The current archive
stores video only, while the live relay carries video and audio.

## Email sign-in

Apply all pending D1 migrations before running or deploying this Worker. Migration
`0010_auth_otp_limits.sql` adds the OTP request time and attempt count used by
the sign-in flow:

```bash
npx wrangler d1 migrations apply DB --local
npx wrangler d1 migrations apply DB --remote
```

`EMAIL_FROM` is `no-reply@auth.trusthentic.com`. The `EMAIL` binding is
restricted to that sender. The sending subdomain must be onboarded in Cloudflare
Email Sending. Local `wrangler dev` simulates delivery and writes messages to
logs and local files; deployed Workers send through Cloudflare Email Service.
Sending to arbitrary OTP recipients requires Workers Paid.

After onboarding the sender and upgrading the Cloudflare account, apply the
OTP migration and deploy the Worker:

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

`POST /v1/auth/request-code` returns `email_unavailable` with HTTP 503 if the
email provider or sender is missing or delivery fails. It limits requests to
one code per address per minute. Codes expire after 15 minutes and allow five
incorrect attempts. `POST /v1/auth/verify` returns a `token` for
`Authorization: Bearer` requests and also sets a session cookie for browser
clients.

## Live rollout order

Do not deploy the organizer-secret API while a game created by an older
broadcaster is live. That game's row has no secret, so the new API would reject
its score, end-game, and publisher capability requests. After the older game
ends, create the R2 bucket, apply all pending D1 migrations, deploy the Worker,
deploy the viewer, then install broadcaster version 1.1.0 (code 2). Start a new
game from the updated app or organizer page; old games cannot claim a secret.
