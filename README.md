# Trip Expense Ledger — offline phone app

Track business trip expenses in any currency, exact to the smallest unit of each
currency (sen, cents, fils, yen…). Works on an Android phone **with or without
internet**, and syncs to your laptop when you're online.

- Everything is saved on the device first, so you can log expenses and take receipt
  photos on a plane or abroad without data.
- When a connection comes back, changes upload automatically and appear on your other
  devices. If the same expense was edited on two devices, the most recent edit wins.
- Data goes to your own free Supabase database. Only your account can read it.

Setup takes about 30 minutes, once. You need: your GitHub account, a computer with
Chrome, and your Android phone.

---

## Step 1 — Create the database (Supabase)

1. Go to **https://supabase.com**, click **Start your project**, and sign in with
   your GitHub account.
2. Click **New project**.
   - Name: `trip-ledger`
   - Database password: click **Generate a password** (you won't need it day to day,
     but save it in your password manager).
   - Region: **Southeast Asia (Singapore)** (closest to Indonesia).
   - Click **Create new project** and wait a minute or two until it's ready.
3. In the left menu click **SQL Editor**, then **New query**.
4. Open the file `supabase/setup.sql` from this folder in a text editor, copy
   **all** of it, paste it into the SQL Editor, and click **Run**.
   You should see "Success. No rows returned".

## Step 2 — Copy your two connection details

1. Click the **Connect** button at the top of your Supabase project page.
2. Copy the **Project URL** (looks like `https://abcdefghij.supabase.co`).
3. Copy the **publishable key** (starts with `sb_publishable_`). You can also find it
   under **Project Settings → API Keys**.
   - Use the *publishable* key only. Never use the *secret* key in this app.

Now put them in the app. Open `js/config.js` in a text editor and fill in the two
values between the quotes:

```js
export const CONFIG = {
  supabaseUrl: "https://abcdefghij.supabase.co",
  supabaseKey: "sb_publishable_xxxxxxxxxxxxxxxx"
};
```

Save the file. (If you skip this, you can instead paste both values into the app on
each device under **Sync & account → Supabase connection**.)

## Step 3 — Create your login

1. In Supabase, left menu: **Authentication → Users**.
2. Click **Add user → Create new user**.
3. Enter your email and a strong password, tick **Auto Confirm User**, click
   **Create user**.
4. So nobody else can create an account in your database: go to
   **Authentication → Sign In / Providers** and turn **off**
   **Allow new users to sign up**, then **Save**.

## Step 4 — Put the app online (GitHub Pages)

1. Go to **https://github.com/new**.
   - Repository name: `trip-ledger`
   - Choose **Public** (GitHub Pages is free for public repositories. Your expense data is
     **not** in the repository. It lives in Supabase, protected by your login.)
   - Click **Create repository**.
2. On the new repository page, click **uploading an existing file**.
3. Open this folder on your computer, select **everything inside it** (the `index.html`
   file and the `css`, `js`, `vendor`, `icons`, `supabase` folders, plus
   `sw.js`, `manifest.webmanifest`, `README.md`) and drag it all into the
   browser window. Wait until every file is listed.
4. Click **Commit changes**.
5. Go to the repository's **Settings → Pages**.
   - Source: **Deploy from a branch**
   - Branch: **main**, folder **/ (root)** → **Save**.
6. Wait 1–2 minutes and refresh that page. It shows your app's address, like
   `https://YOUR-GITHUB-NAME.github.io/trip-ledger/`.

## Step 5 — Install on your Android phone

1. On the phone, open **Chrome** and go to your app address from step 4.
2. Tap the **⋮** menu → **Add to Home screen** → **Install**.
   (Chrome may also show an **Install app** banner. Either works.)
3. Open **Trip Ledger** from your home screen.
4. Tap the status button at the top right (it says *Not signed in*) and sign in
   with the email and password from step 3.
5. The status changes to **Synced just now**. You're done.

**Test offline:** turn on Airplane mode, close the app completely, and open it again.
It opens with all your data. Add an expense; the status shows *Offline · 1 change
waiting*. Turn Airplane mode off and it syncs by itself within a few seconds.

## Step 6 — Your laptop (Mac or Windows)

Open the same address in Chrome or Edge, sign in, and everything syncs down,
including receipt photos. To install it like an app, click the install icon at
the right end of the address bar.

---

## Everyday use

- **Status button (top right)**: tells you whether you're synced, offline, or how many
  changes are waiting. Tap it for details and **Sync now**.
- **Receipts**: *Take photo* (phone camera) or *Attach photo or PDF*. Photos are
  resized to a sharp, readable size so they upload quickly on mobile data.
- **"Not synced yet"** under an expense means it's saved on this device and will upload
  when you're online.
- **Export CSV** downloads the current trip for finance, with a total row.

## How amounts are stored

Every amount is a whole number of the currency's smallest unit, using the ISO 4217
standard (e.g. JPY 3,480 → `3480`, KWD 12.345 → `12345` fils, IDR 15,000.50 → `1500050`
sen). Exchange rates are kept as exact text (up to 12 decimals). The conversion to your
home currency is exact integer maths, rounded once to the nearest smallest unit of the
home currency (halves round away from zero). No floating-point rounding anywhere.

## Updating the app later

1. Change the files you need to change.
2. In `sw.js`, raise the version on line 3 (e.g. `v1.0.0` → `v1.0.1`). This tells every
   device there's a new version.
3. Upload the changed files to GitHub again (**Add file → Upload files**, commit).
4. Next time the app opens online, it shows **"A new version of the app is ready"**.
   Tap **Update now**.

## Good to know

- **Storage on the phone**: the app asks Chrome to protect its data from automatic
  clean-up. Uninstalling the app or clearing Chrome's site data removes what hasn't
  synced yet, so sync regularly before doing either.
- **Receipt photos** are about 300–600 KB each. Supabase's free plan includes 1 GB of
  file storage, enough for roughly 2,000 receipts.
- **Free-plan pause**: Supabase pauses free projects after about a week with no
  activity. Your data is kept; open the Supabase dashboard and click **Restore** if sync
  stops working after a long break. The app keeps working offline either way.
- **Signing out** keeps the data on that device.

## Files

| File | What it does |
|---|---|
| `index.html`, `css/app.css` | Screens and layout |
| `js/app.js` | Screens and form logic |
| `js/money.js` | Exact currency maths and the currency list |
| `js/db.js` | Storage on the device (IndexedDB) |
| `js/sync.js` | Sync with Supabase |
| `js/config.js` | Your Supabase project URL and publishable key |
| `sw.js` | Keeps the app available offline |
| `manifest.webmanifest`, `icons/` | Makes it installable as a phone app |
| `vendor/supabase-2.117.2.js` | Supabase's official browser library (kept locally so it works offline) |
| `supabase/setup.sql` | Database tables, the most-recent-edit-wins rule, and access rules |
