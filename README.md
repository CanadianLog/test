# Ad Screen

Turns a Chromebook plugged into a TV/monitor into an advertising screen, with a web dashboard where your customer logs in and changes their ads.

- **Player** (`/screen/<key>`): full-screen slideshow of pictures and videos. It loops forever, picks up changes within 30 seconds, keeps playing from its cache if the internet drops, keeps the display awake, and reloads itself every night at 3am.
- **Dashboard** (`/admin`): customers log in, drag and drop pictures or videos, change the order, set how many seconds each picture shows, switch ads on or off, and set start and end dates. It also shows whether their screen is online.
- **Admin**: you create customer accounts, reset passwords, and can "Manage ads" for any customer. Each customer gets their own screen link, so one server can run many screens.

## 1. Run the server

The server has to be reachable on the internet so the Chromebook and your customer can both use it. Any small VPS (DigitalOcean, Linode, Hetzner, etc., about $5 a month) or a host like Render or Railway with a persistent disk will work.

```bash
npm install
ADMIN_PASSWORD='choose-a-strong-one' npm start
# → http://your-server:3000/admin   (username: admin)
```

**On Render:** the repo includes a `render.yaml`. In the Render dashboard choose **New → Blueprint**, pick this repo, enter an `ADMIN_PASSWORD`, and it creates the service on the Starter plan with a 5 GB disk at `/data`. The free plan won't work, because it has no permanent disk and uploaded ads would disappear on every restart.

Or with Docker:

```bash
docker build -t ad-screen .
docker run -d --restart unless-stopped -p 3000:3000 \
  -e ADMIN_PASSWORD='choose-a-strong-one' -v adscreen-data:/data ad-screen
```

Put it behind HTTPS (for example Caddy: `caddy reverse-proxy --from ads.yourdomain.com --to localhost:3000`). HTTPS is needed for offline caching and the keep-awake feature to work on the Chromebook.

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `ADMIN_PASSWORD` | random, printed at first start | Admin password (used only on first start) |
| `ADMIN_USER` | `admin` | Admin username (used only on first start) |
| `DATA_DIR` | `./data` | Where the database and uploaded ads are stored. **Back this up.** |
| `MAX_UPLOAD_MB` | `500` | Max size per uploaded file |

## 2. Create the customer

Log in as admin → **Customers** → add their business name, username and password. Give the customer the dashboard address (`https://ads.yourdomain.com`) and their login.

## 3. Set up the Chromebook (one time)

1. Sign in on the Chromebook. Log in to the dashboard as the customer (or as admin, then **Manage ads**), open the **Screen** tab and open the **screen link**.
2. **Install it as an app**: click the install icon in the address bar, or ⋮ → *Cast, save, and share* → *Install page as app*. The app opens full screen with no browser bars.
3. **Start it automatically**: Settings → *Apps* → **Restore apps on startup** → **Always restore**. Leave the Ad Screen app open when the Chromebook is turned off (don't close its window). After sign-in, ChromeOS reopens it.
   Personal Chromebooks have no "open this app at every login" switch. That needs a managed Chromebook (see *Fully hands-off* below), where the Admin console can auto-launch the app.
4. **Keep the screen on**: Settings → *Device* → *Power* → When idle: **Keep display on**. If the lid is closed, turn off *Sleep when cover is closed*.
5. Turn off the lock screen on wake (Settings → *Security and privacy* → *Lock screen*).

After that, turning on the Chromebook and signing in starts the ads.

### Fully hands-off (no sign-in at all)

A personal Chromebook always asks for a password after a full power-off. To boot straight into the ads with no sign-in, the Chromebook needs **Chrome Enterprise / Chrome Education Upgrade** (about $50 one time per device, or a Google "Kiosk & Signage" licence). In the Google Admin console:

*Devices → Chrome → Apps & extensions → Kiosks* → add the screen link as a **kiosk URL app**, and set it to **auto-launch**.

The Chromebook then boots directly into the ad player and recovers by itself after a power cut.

## Vertical (portrait) screens

Mount the TV on its side, then in the dashboard go to **Screen → Screen orientation** and choose **Portrait**. The player rotates itself, so you don't need to change any Chromebook settings. If the ads come out upside down, choose the other Portrait option. Make vertical ads at **1080×1920**.

(Or rotate the display in ChromeOS instead: Settings → *Device* → *Displays* → *Orientation*, and leave the dashboard on Landscape. Use one method, not both.)

## YouTube ads

In **My ads**, paste a YouTube link (normal video, `youtu.be` short link, or Shorts) into *Add YouTube video*. It goes in the playlist like any other ad. It plays the whole video, or set **Max seconds** to cut it short.

- YouTube ads need internet. If the connection drops, the screen skips them and keeps playing uploaded pictures and videos.
- The video's owner must allow embedding. Most videos do. If one doesn't, or it's private or deleted, the screen skips it.
- Sound follows the *Mute video sound* setting.
- YouTube may play its own ads before some videos, which YouTube and the video's owner control. To avoid that, upload the video file instead (best for the customer's own videos).
- For vertical screens, YouTube **Shorts** fill the screen best.

## Instagram

There are two ways to get Instagram posts onto the screen.

**1. Save and upload (works now, no setup).** The customer saves their own Reel from the Instagram app (⋯ → *Download* / *Save to device*), then uploads it from their phone in the dashboard. The dashboard has these steps under *My ads → Instagram*.

**2. Connect Instagram (one-time setup by you).** The customer clicks **Connect Instagram**, then picks posts to put on the screen, or turns on **Automatically add new Reels**, which checks every 30 minutes. The server copies each post, so it also plays when the internet is down. This uses Instagram's official API, so:

- The customer's Instagram must be a **Business or Creator** account. They can switch for free: Instagram app → Settings → *Account type and tools*.
- You need a free **Meta developer app**. Set it up once for all your customers:

1. Go to **developers.facebook.com** → *My Apps* → **Create app**. Choose the use case for managing content on Instagram (Meta renames these menus from time to time).
2. In the app, open **Instagram → API setup with Instagram login**. Copy the **Instagram app ID** and **Instagram app secret**. These are *not* the Facebook app ID.
3. Under **Set up Instagram business login → Business login settings**, add this **OAuth redirect URI**:
   `https://YOUR-SITE/auth/instagram/callback`
   (for example `https://ad-screen-9s7k.onrender.com/auth/instagram/callback`). The admin dashboard shows the exact address under *My ads → Instagram* until it's set up.
4. In Render → your service → **Environment**, add:
   - `IG_APP_ID` = the Instagram app ID
   - `IG_APP_SECRET` = the Instagram app secret
   - `PUBLIC_URL` = `https://YOUR-SITE` (optional, but recommended if you add your own domain)

   Save. Render restarts the app.
5. **Let your customer connect.** While the Meta app is in *Development* mode, only accounts you invite can connect:
   - Meta app → *App roles → Roles* → **Add Instagram testers** → enter the customer's Instagram username.
   - The customer accepts the invite in Instagram: Settings → *Website permissions → Apps and websites → Tester invites*, or at instagram.com/accounts/manage_access.

   That's fine for a handful of customers. To let anyone connect without an invite, submit the app for Meta's *App Review* (permission `instagram_business_basic`).

Notes:
- Access is renewed automatically. If Instagram ever cancels it (password change, access removed), the dashboard shows **Reconnect Instagram**.
- Auto-add only picks up Reels posted *after* it's switched on, so it won't flood the screen with old posts.
- Some Reels that use licensed music can't be copied. Instagram doesn't provide their file.
- iPhone **HEIC** photos are rejected with a message, because Chrome can't display them. Upload a JPG or a screenshot instead.

## Tips

- Pictures: use 1920×1080 landscape JPG or PNG. Videos: use MP4 (H.264). Videos play all the way through and are muted unless you turn off *Mute video sound* in Screen settings.
- **Reload screen now** (Screen tab) makes the Chromebook reload straight away, for example after a big change.
- Lost screen link or shared it by mistake? It is the secret part of the URL. Rotate it with `POST /api/users/<id>/newkey` as admin, then reinstall the app on the Chromebook.
