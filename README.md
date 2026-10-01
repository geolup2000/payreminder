# PayReminder

PayReminder helps you track recurring payments for multiple services. Create services, assign members to one or more services, send monthly reminders, and review payment reports from an admin panel.

PayReminder does **not** charge cards or process payments. Members pay through the payment link configured for a service. An administrator checks the transaction and confirms it in PayReminder.

## Features

- Multiple services, each with its own payment link, active status, and reminder schedule.
- Members can be assigned to multiple services, with a separate monthly amount for each.
- Automatic and manual reminder emails. A member subscribed to several services receives one reminder email per service; each email links to the member's personal page.
- A personal page where members can see their subscriptions, open the relevant payment link, and report a payment.
- Optional Telegram notifications when a member reports a payment.
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

- Node.js 18 or newer and npm.
- Linux installation script: Debian or Ubuntu in an LXC container, with root access. Do not run the installer on the Proxmox host.
- An SMTP account to send email. Telegram is optional.
- For public access, a domain and an HTTPS reverse proxy such as Caddy or Nginx.

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

On Windows PowerShell, copy the environment file with:

```powershell
Copy-Item .env.example .env
```

Before using the application, edit `.env`. Set a strong `ADMIN_PASSWORD`, a long random `SESSION_SECRET`, the correct `APP_URL`, and your SMTP details. Without SMTP credentials, the app starts but does not send emails. Telegram notifications are optional.

Open:

- Admin panel: <http://localhost:3000/admin>
- Public home page: <http://localhost:3000>

The default local admin username is `admin`. Set your own username and password in `.env` before exposing the app to a network.

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

The installer installs Node.js 22 if Node.js 18 or newer is not already available, installs production npm dependencies, creates `.env` from `.env.example` if needed, prompts for a public `APP_URL` when the current value is localhost, initializes the application language to English for a new installation, and creates/enables the `payreminder` systemd service when systemd is available.

The service may start before SMTP and Telegram are configured. Edit the generated `.env`, then restart the service:

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

For public access, point a reverse proxy at the app's local port (default `3000`) and enable HTTPS. Set `APP_URL` to the public HTTPS URL, for example `https://reminder.example.com`; this URL is used in member emails and Telegram payment notifications. Restrict direct access to the app port at the firewall so public traffic goes through the HTTPS proxy.

The installer does not configure DNS, HTTPS, a reverse proxy, or firewall rules.

## Configuration

`.env.example` documents the supported environment variables. The most important settings are:

| Variable | Purpose |
| --- | --- |
| `PORT` | Local HTTP port; defaults to `3000`. |
| `APP_URL` | Public application URL used to build member and admin links. |
| `ADMIN_USER` | Admin panel username; defaults to `admin`. |
| `ADMIN_PASSWORD` | Admin panel password. Set a unique, strong value. |
| `SESSION_SECRET` | Secret used to sign admin sessions. Use a long, random value. |
| `SMTP_HOST`, `SMTP_PORT` | SMTP server hostname and port. Use the values from your email provider; port `587` with STARTTLS is typical. |
| `SMTP_USER`, `SMTP_PASS` | SMTP login. Both are required to enable email sending. |
| `SMTP_FROM_NAME`, `SMTP_FROM_ADDRESS` | Optional sender display name and address. If the address is blank, the SMTP username is used. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional bot and destination for admin payment notifications. Both are required to enable Telegram. |
| `CURRENCY` | Currency label shown in the app; defaults to `RON`. |
| `DEFAULT_AMOUNT` | Suggested amount when adding a member; defaults to `15`. |
| `DEFAULT_SERVICE_NAME` | Name of the initial service; defaults to `Service`. |
| `SEND_CONFIRM_TO_MEMBER` | Whether payment confirmation emails are sent; defaults to `true`. |

The application language is stored in `data/settings.json` and changed from **Admin → Settings**. The Linux installer sets English for a new installation and preserves a previously selected Romanian or English language. A manual installation without an existing language setting starts in Romanian; choose the language from the admin panel.

### Configure SMTP

Enter the SMTP host, port, username, and password provided by your email service. Many providers require an app password or SMTP access to be enabled. The example file leaves SMTP values blank intentionally. If `SMTP_USER` or `SMTP_PASS` is missing, email sending is disabled.

The app uses STARTTLS (`requireTLS`) and a non-secure SMTP connection upgraded with TLS, commonly on port `587`. Check your provider's SMTP documentation if it requires different settings.

### Configure Telegram (optional)

1. Create a bot with Telegram's `@BotFather` and copy its token to `TELEGRAM_BOT_TOKEN`.
2. Find the destination chat ID and set `TELEGRAM_CHAT_ID`.
3. Restart PayReminder after changing `.env`.

Telegram messages include the member name, service, reported amount, month, and a link to the admin confirmation page. Keep the bot token private.

## First-time setup in the admin panel

1. Sign in at `/admin`.
2. Open **Services** and edit the initial service or add another. Enter its payment URL, set the reminder day and hour, and make sure it is active.
3. Open **Members**, add each person, and select their services. Enter the monthly amount for each service and provide a working email address.
4. Open **Settings** and choose Romanian or English. The selection controls both the application interface and member emails.
5. Use **Payments** to review reported payments and record advance payments.

No payment links are preconfigured. Verify each service's payment URL before inviting members.

## Reminder and payment workflow

1. At the configured day and hour for an active service, PayReminder checks for members who are active, subscribed to that service, and have no payment recorded for the current month.
2. It sends each matching member a service-specific email with the amount and a link to their personal page.
3. The member opens the service's payment link and reports the payment from their personal page.
4. PayReminder optionally sends a Telegram notification to the admin. The notification is informational; it does not verify the transaction.
5. The admin checks the payment with the service provider and confirms it in **Payments** or from the dashboard.
6. If enabled, PayReminder sends the member a confirmation email.

Reminder day and hour are configured separately for each service and use the server's local timezone. Keep the app running continuously for scheduled reminders. The scheduler checks once per minute. If the server is down at the configured time, the reminder is not guaranteed to be sent later that day.

Advance payments are recorded as confirmed and cover the selected consecutive months. The amount is calculated from the member's configured monthly amount multiplied by the number of months.

## Admin pages

| Path | Purpose |
| --- | --- |
| `/admin` | Payment overview, service filter, quick reminders, and manual confirmation actions. |
| `/admin/services` | Add, edit, activate/deactivate, and schedule services. |
| `/admin/members` | Manage members, service assignments, amounts, and personal links. |
| `/admin/payments` | Filter payment reports, confirm or remove records, and record advance payments. |
| `/admin/settings` | Choose the application and email language. |

## Data, backups, and updates

All application data is stored as JSON files in `data/`:

- `services.json` — services and reminder schedules;
- `members.json` — member details and service assignments;
- `payments.json` — reported and confirmed payments;
- `settings.json` — language preference and reminder bookkeeping.

Back up the entire `data/` directory and `.env` regularly. The `.env` file contains credentials and secrets; keep it private and do not commit it to Git. Restoring the data directory and matching `.env` restores the local application state.

To update an existing Linux installation, first make sure any local changes are committed or backed up, then pull and restart:

```bash
cd /opt/payreminder
git pull
npm ci --omit=dev
systemctl restart payreminder
```

If `git pull` reports local changes would be overwritten, inspect them before discarding or stashing anything. For example, `git diff -- install.sh` shows local installer changes.

## Troubleshooting

- **Emails are not sent:** Check `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS`; review `journalctl -u payreminder -f`. Emails are disabled when SMTP credentials are missing.
- **Telegram notifications are missing:** Check both Telegram variables, make sure the bot can message the configured chat, and inspect the service logs.
- **Links point to localhost or the wrong host:** Set `APP_URL` to the public HTTPS address and restart the service.
- **Scheduled reminders do not run:** Keep the service active, check the server timezone, confirm the service is active, and review its reminder day/hour and logs.
- **Admin login stops working after a restart:** Admin sessions are stored in memory, so a restart requires signing in again.
- **A Git update is blocked by local edits:** Inspect the reported files with `git diff`; commit, back up, or stash the changes before pulling.

## Development

```bash
npm install
npm run dev
```

`npm run dev` starts Node's watch mode. The application is built with Express and EJS, uses `node-cron` for reminders, and uses Nodemailer for SMTP email.
