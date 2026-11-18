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
3. **Start it automatically**: Settings → *Apps* → *Ad Screen* (or right-click it in the Launcher → *App info*) → turn on **Open at login / Run on OS login**.
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

## Tips

- Pictures: use 1920×1080 landscape JPG or PNG. Videos: use MP4 (H.264). Videos play all the way through and are muted unless you turn off *Mute video sound* in Screen settings.
- **Reload screen now** (Screen tab) makes the Chromebook reload straight away, for example after a big change.
- Lost screen link or shared it by mistake? It is the secret part of the URL. Rotate it with `POST /api/users/<id>/newkey` as admin, then reinstall the app on the Chromebook.
