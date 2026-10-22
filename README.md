# PayReminder

PayReminder helps you track recurring payments for multiple services. Create services, assign members to one or more services, send monthly reminders, and review payment reports from an admin panel.

PayReminder does **not** charge cards or process payments. Members pay through the payment link configured for a service. An administrator checks the transaction and confirms it in PayReminder.

## Features

- Multiple services, each with its own payment link, active status, and reminder schedule.
- Members can be assigned to multiple services, with a separate monthly amount for each.
- Automatic and manual reminder emails. A member subscribed to several services receives one reminder email per service; each email links to the member's personal page.
- A personal page where members can see their subscriptions, open the relevant payment link, and report a payment.
- Optional Telegram and Discord webhook notifications when a member reports a payment, configured directly in **Admin → Settings** with a separate active switch for each agent.
- Manual payment confirmation and optional confirmation emails to members.
- Optional advance payments covering multiple consecutive months.
- Romanian and English interface and email templates. Choose the language in **Admin → Settings**.
- Local JSON storage; no external database is required.

## Screenshots

<details>
<summary>Show screenshots</summary>

### Admin dashboard

![PayReminder admin dashboard](docs/screenshots/admin-dashboard.png)

### Services list

![PayReminder services list](docs/screenshots/admin-services.png)

### Add or edit a service

![PayReminder service form](docs/screenshots/admin-service-form.png)

### Members list

![PayReminder members list](docs/screenshots/admin-members.png)

### Add or edit a member

![PayReminder member form](docs/screenshots/admin-member-form.png)

### Payments and advance payments

![PayReminder payments page](docs/screenshots/admin-payments.png)

### Member payment page

![PayReminder member payment page](docs/screenshots/member-page.png)

</details>

## Requirements

- Node.js 20 or newer and npm; Node.js 22 is recommended. Older versions are unsupported, including when installed through a distribution-package fallback.
- Linux installation script: Debian or Ubuntu in an LXC container, with root access. Do not run the installer on the Proxmox host.
- An SMTP account to send email. Telegram and Discord notifications are optional.
- For public access, a domain and an HTTPS reverse proxy such as Caddy or Nginx.

## Quick start

```bash
npm install
cp .env.example .env
chmod 600 .env
nano .env # Set ADMIN_PASSWORD and SESSION_SECRET before starting; see below.
npm start
```

On Windows PowerShell, copy the environment file with:

```powershell
Copy-Item .env.example .env
```

Before `npm start` (or `npm run dev`), edit `.env` with your preferred editor (`notepad .env` on Windows). Set a unique `ADMIN_PASSWORD` of at least 12 characters and a cryptographically random `SESSION_SECRET` of at least 32 characters, using a password manager or secure random generator. These fields are deliberately blank in `.env.example`; blank, short, and known example/default credentials cause startup to fail before the HTTP port opens. Do not put secrets in shell history, logs, screenshots, or Git. On Windows, restrict the file's permissions to the account running the app instead of using `chmod`.

Set `APP_URL` to an HTTP(S) origin such as `https://reminder.example.com` (no credentials, path, query, or fragment), and configure your SMTP details. Without SMTP credentials, the app starts but does not send emails. Configure optional Telegram and Discord notifications from **Admin → Settings → Notifications**; new installations do not need notification variables in `.env`.

Open:

- Admin panel: <http://localhost:3000/admin>
- Public home page: <http://localhost:3000>

The default admin username is `admin`, but there is no usable default password. Keep the app port firewalled until setup and HTTPS are complete. `APP_URL=http://localhost:3000` controls generated links; it does not restrict the server's listening interfaces.

## Install on Debian or Ubuntu LXC

Run these commands **inside** the LXC container, not on the Proxmox host:

```bash
apt-get update
apt-get install -y git ca-certificates curl
git clone https://github.com/geolup2000/payreminder.git /opt/payreminder
cd /opt/payreminder
chmod +x install.sh
./install.sh /opt/payreminder
```

The installer:

- Keeps an installed Node.js version only if it is at least 20; otherwise it attempts to install Node.js 22 and checks the final version again, including after a distribution-package fallback. An unsupported final version stops installation.
- Resolves the project directory to an absolute, physical path. Project and Node executable paths must contain only letters, digits, `/`, `.`, `_`, and `-`; spaces and systemd expansion/quoting characters are rejected rather than interpolated into a service unit.
- Installs production npm dependencies. On a **new installation**, creates `.env` exclusively with mode `600`, a cryptographically random 48-character admin password, and a random 64-character session secret. The password and secret are **not printed**; inspect `/opt/payreminder/.env` locally to retrieve the password. The username is `admin` unless you change it.
- Preserves an existing `.env` and existing application settings byte-for-byte, including comments and credentials. It never prompts to overwrite an existing `APP_URL`, resets settings, or replaces existing credentials.
- Validates the actual `.env` with the application's runtime validator **before creating, enabling, or starting the service**. An insecure existing configuration stops installation without starting/restarting the app; fix it manually and rerun. It does not automatically migrate insecure credentials.
- Initializes English only for a new installation without existing settings, then creates/enables the `payreminder` systemd service when systemd is available.

New installations can start automatically only after secure credentials have been generated and configuration validation succeeds. The installer does not configure SMTP or public exposure. Keep the app port firewalled during setup. Set your public `APP_URL`, inspect/store the generated credentials securely, and configure SMTP before inviting members:

```bash
nano /opt/payreminder/.env
systemctl restart payreminder
systemctl status payreminder
```

View logs with:

```bash
journalctl -u payreminder -f
```

If the container does not use systemd, start the app manually from the project directory:

```bash
cd /opt/payreminder
node src/server.js
```

### Expose the app safely

For public access, point a reverse proxy at the app's local port (default `3000`) and enable HTTPS. Set `APP_URL` to the public HTTPS URL, for example `https://reminder.example.com`; this URL is used in member emails and payment notifications. Restrict direct access to the app port at the firewall so public traffic goes through the HTTPS proxy.

The installer does not configure DNS, HTTPS, a reverse proxy, or firewall rules.

### Security and deployment limits

- Use HTTPS for network access and protect the admin account with a unique password. Member personal URLs are bearer links: anyone holding a link can view/report that member's payments; do not publish them.
- Admin state-changing requests require a CSRF token from the rendered form (or the `X-CSRF-Token` header). Scripts must retain the session/cookies and send a current token; missing or invalid tokens are rejected. Do not disable CSRF protection to work around stale forms; reload and sign in again if needed.
- Normal SIGTERM/SIGINT shutdown waits for HTTP requests and accepted deliveries before releasing the data lock. The generated systemd unit uses `TimeoutStopSec=infinity` so a long campaign is not forcibly killed during this drain (rerun the installer to update an existing unit). If persistence fails during shutdown, the process keeps the lock and logs the error; restore storage access and send another SIGTERM/SIGINT to the process to retry shutdown.
- New payment reports persist pending Telegram/Discord notifications with the payment. Failed or disabled channels retry on startup, every minute, and when the report is submitted again; channels recorded as sent are skipped. Older payments without delivery records are not replayed. A forced kill or power loss after a provider accepts a message but before its success is saved can still cause a duplicate on restart.
- JSON storage is **single-writer**: run exactly one application process against a data directory. Do not use Node cluster mode, multiple replicas/containers sharing the directory, or a second manual process alongside systemd. File writes are not a substitute for a multi-process database.
- The installer preserves existing configuration; it does not automatically migrate insecure credentials. Replace insecure/legacy `ADMIN_PASSWORD` and `SESSION_SECRET` yourself before restarting an upgraded application. Rotating the session secret invalidates existing sessions. Back up `.env` and `data/` privately first.

## Configuration

`.env.example` documents the environment variables for server, admin, email, and payment defaults. Language and notification agents are configured in **Admin → Settings**. The most important environment settings are:

| Variable | Purpose |
| --- | --- |
| `PORT` | Local HTTP port; defaults to `3000`. |
| `APP_URL` | HTTP(S) origin used to build member/admin links; no path, credentials, query, or fragment. Does not control the bind address. |
| `ADMIN_USER` | Admin panel username; defaults to `admin`. |
| `ADMIN_PASSWORD` | Required unique admin password, at least 12 characters; blank/default/example values are rejected. |
| `SESSION_SECRET` | Required random session signing secret, at least 32 characters; blank/default values are rejected. |
| `SMTP_HOST`, `SMTP_PORT` | SMTP server hostname and port. Use the values from your email provider; port `587` with STARTTLS is typical. |
| `SMTP_USER`, `SMTP_PASS` | SMTP login. Both are required to enable email sending. |
| `SMTP_FROM_NAME`, `SMTP_FROM_ADDRESS` | Optional sender display name and address. If the address is blank, the SMTP username is used. |
| `CURRENCY` | Currency label shown in the app; defaults to `RON`. |
| `DEFAULT_AMOUNT` | Suggested amount when adding a member; defaults to `15`. |
| `DEFAULT_SERVICE_NAME` | Name of the initial service; defaults to `Service`. |
| `SEND_CONFIRM_TO_MEMBER` | Whether payment confirmation emails are sent; defaults to `true`. |

The application language is stored in `data/settings.json` and changed from **Admin → Settings**. The Linux installer sets English only for a new installation without existing settings and otherwise leaves the entire settings file unchanged. A manual installation without an existing language setting starts in Romanian; choose the language from the admin panel.

### Configure SMTP

Enter the SMTP host, port, username, and password provided by your email service. Many providers require an app password or SMTP access to be enabled. The example file leaves SMTP values blank intentionally. If `SMTP_USER` or `SMTP_PASS` is missing, email sending is disabled.

The app uses STARTTLS (`requireTLS`) and a non-secure SMTP connection upgraded with TLS, commonly on port `587`. Check your provider's SMTP documentation if it requires different settings.

### Configure notifications (optional)

Open **Admin → Settings → Notifications**, choose **Telegram** or **Discord**, and check **Active** to show its configuration fields. Each agent is enabled independently, so both can be active. Unchecking Active hides the fields and preserves their values. Save to apply changes immediately, without restarting.

- **Telegram:** create a bot with `@BotFather`, copy its token into `TELEGRAM_BOT_TOKEN`, and enter the destination chat ID in `TELEGRAM_CHAT_ID`. Make sure the bot can send messages to that chat.
- **Discord:** create a webhook under the channel's **Integrations → Webhooks** settings and enter `DISCORD_WEBHOOK_URL`. Set **Application name** to the sender name shown in Discord (up to 80 characters; defaults to `PayReminder`). The avatar automatically uses the PayReminder favicon, served as a PNG at `APP_URL/favicon.png`. Set `APP_URL` to a publicly accessible HTTPS address so Discord can load it; no image URL needs to be entered.

Configuration is stored in `data/settings.json`. Existing notification variables in `.env` are used until you first save these settings; afterward, the saved settings take priority and those variables can be removed from `.env`. Include settings.json in backups and keep it private: it contains notification credentials.

The agent selector only changes which configuration is displayed; it does not disable the other agent. To enable both, select Telegram, check **Active** and fill in its fields, then select Discord and do the same. Click **Save settings** to save both configurations together. To disable an agent, select it, uncheck **Active**, and save. Its credentials remain available if you enable it again later. Active Telegram requires both fields, and active Discord requires a valid Discord webhook URL.

Each active agent has a **Send test message** button. The test uses the current form values without saving them and sends a confirmation message in the language selected in the form. The page shows success or a localized error if validation or delivery fails. Save settings after a successful test to apply the configuration to future payment notifications.

Notifications use the Romanian or English language selected in **Admin → Settings**, including the message text, month, amount formatting, and confirmation link label. They include the member, service, amount, month, and admin confirmation link. Language changes apply to subsequent notifications immediately after saving. Failure on one channel does not prevent the other from sending. Discord messages suppress mentions. See the [Discord webhook documentation](https://docs.discord.com/developers/resources/webhook#execute-webhook).

## First-time setup in the admin panel

1. Sign in at `/admin`.
2. Open **Services** and edit the initial service or add another. Enter its payment URL, set the reminder day and hour, and make sure it is active.
3. Open **Members**, add each person, and select their services. Enter the monthly amount for each service and provide a working email address.
4. Open **Settings** and choose Romanian or English. The selection controls both the application interface and member emails. Under **Notifications**, optionally configure and activate Telegram, Discord, or both, then save.
5. Use **Payments** to review reported payments and record advance payments.

No payment links are preconfigured. Verify each service's payment URL before inviting members.

## Reminder and payment workflow

1. At the configured day and hour for an active service, PayReminder checks for members who are active, subscribed to that service, and have no payment recorded for the current month.
2. It sends each matching member a service-specific email with the amount and a link to their personal page.
3. The member opens the service's payment link and reports the payment from their personal page.
4. PayReminder optionally sends Telegram and/or Discord notifications to the admin. The notification is informational; it does not verify the transaction.
5. The admin checks the payment with the service provider and confirms it in **Payments** or from the dashboard.
6. If enabled, PayReminder sends the member a confirmation email.

Reminder day and hour are configured separately for each service and use the server's local timezone. The scheduler checks once per minute. Catch-up is limited to the current month's schedule: a missed due time can be processed on a later check in the same month, not as a backlog of earlier months. Keep the app running continuously, use one writer, and monitor delivery failures; SMTP delivery and bookkeeping are not an exactly-once transaction, so failures or crashes can cause retries or duplicates.

Advance payments are recorded as confirmed and cover the selected consecutive months. The amount is calculated from the member's configured monthly amount multiplied by the number of months.

## Admin pages

| Path | Purpose |
| --- | --- |
| `/admin` | Payment overview, service filter, quick reminders, and manual confirmation actions. |
| `/admin/services` | Add, edit, activate/deactivate, and schedule services. |
| `/admin/members` | Manage members, service assignments, amounts, and personal links. |
| `/admin/payments` | Filter payment reports, confirm or remove records, and record advance payments. |
| `/admin/settings` | Choose the application and email language; configure and activate Telegram and Discord notifications, including the Discord application name and automatic favicon avatar. |

## Reverse proxy and login protection

Login attempts are limited per client address. Forwarding headers are untrusted by default. If Caddy, Nginx, or another reverse proxy handles requests, set `TRUST_PROXY` in `.env` to a comma-separated list of the **actual proxy peer IP addresses or CIDRs**, then restart. For a proxy running on the same host:

```dotenv
TRUST_PROXY=127.0.0.1/32,::1/128
```

For a proxy on another host/container, use its exact address instead. Keep the application port reachable only by trusted proxies and have the proxy overwrite incoming forwarding headers. Do not trust every address, broad client networks, arbitrary hop counts, or a client-provided header directly. Without a configured trust boundary, clients behind one proxy share its login-attempt limit. Use an HTTPS `APP_URL`; authentication cookies then require HTTPS even when the proxy talks HTTP to Node.

## Data, backups, and updates

All application data is stored as JSON files in `data/`:

- `services.json` — services and reminder schedules;
- `members.json` — member details and service assignments;
- `payments.json` — reported and confirmed payments;
- `settings.json` — language preference, notification agent settings and credentials, and reminder bookkeeping.

Back up the entire `data/` directory and `.env` regularly. Both `.env` and `data/settings.json` contain credentials and secrets; keep them private and do not commit them to Git. Restoring the data directory and matching `.env` restores the local application state, including saved notification configurations.

Only one application process may own a data directory. Startup acquires `data/.payreminder.lock`; normal process exit releases it. If a forced kill or machine crash leaves the lock behind, **stop every instance and verify the recorded owner is no longer running before manually removing only that lock file**. Never delete JSON data files as lock recovery. Programmatic `shutdown()` drains accepted reminders before releasing storage ownership; abrupt termination cannot guarantee exactly-once email delivery.

Unreadable or malformed JSON fails visibly rather than being replaced with empty data. Historical numeric floating-point residue from prepaid multiplication (for example `37.019999999999996`) is recognized within a very small machine-precision tolerance and normalized in memory, without rewriting the file on read. Genuine excess precision such as `1.005`, negative amounts, and malformed monetary values require deliberate data correction from a verified backup; new amounts must have at most two decimal places.

Legacy service-wide reminder markers are converted to recipient-specific markers for subscriptions present on the first upgraded scheduler start. The old data does not record who actually received each historical reminder, so this snapshot conservatively preserves that month's previous suppression. After migration, new members/subscriptions can receive their first reminder without repeating successful recipients.

To update an existing Linux installation, first make sure any local changes are committed or backed up, then pull and restart:

```bash
cd /opt/payreminder
git pull
npm ci --omit=dev
node -e "require('./src/config').validateRuntimeConfig()"
systemctl restart payreminder
```

If `git pull` reports local changes would be overwritten, inspect them before discarding or stashing anything. For example, `git diff -- install.sh` shows local installer changes.

Before restarting, review the Node.js requirement and credential validation above. Upgrades do not generate replacements for insecure credentials in an existing `.env`; startup will fail until you deliberately update them. Stop any second application process before starting the service. Re-running `install.sh` also preserves `.env` and existing settings and validates configuration before service setup.

## Troubleshooting

- **Emails are not sent:** Check `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS`; review `journalctl -u payreminder -f`. Emails are disabled when SMTP credentials are missing.
- **Discord notifications are missing:** In **Admin → Settings → Notifications**, select Discord, make sure **Active** is checked, verify the webhook URL, and save. Make sure the webhook still exists and can post to the channel, and inspect the service logs. If the avatar is missing, check that `APP_URL/favicon.png` is publicly accessible.
- **Telegram notifications are missing:** In **Admin → Settings → Notifications**, select Telegram, make sure **Active** is checked, verify the bot token and chat ID, and save. Make sure the bot can message the configured chat, and inspect the service logs.
- **Links point to localhost or the wrong host:** Set `APP_URL` to the public HTTPS address and restart the service.
- **Scheduled reminders do not run:** Keep the service active, check the server timezone, confirm the service is active, and review its reminder day/hour and logs.
- **Admin login stops working after a restart:** Admin sessions are stored in memory, so a restart requires signing in again.
- **A Git update is blocked by local edits:** Inspect the reported files with `git diff`; commit, back up, or stash the changes before pulling.

## Development

```bash
npm install
# Configure .env as in Quick start before running the development server.
npm run dev
```

Run the test suite with `npm test`. Installer tests extract and exercise isolated functions with mocked system/package-manager commands; they never execute the installer on the host.

`npm run dev` starts Node's watch mode. The application is built with Express and EJS, uses `node-cron` for reminders, and uses Nodemailer for SMTP email.
