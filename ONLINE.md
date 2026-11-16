# Online play setup

Online matches are peer-to-peer (WebRTC). The host's browser runs the game and streams it to
up to 3 friends. Firebase is only used for the room code handshake (a few KB per join), so the
free plan is plenty.

## 1. Create the database (one time, ~5 minutes)

1. Go to https://console.firebase.google.com and click **Add project** (any name, e.g. `bender-sand`). Analytics can be off.
2. In the left menu: **Build → Realtime Database → Create Database**. Pick a location, choose **Start in locked mode**.
3. Open the **Rules** tab, replace everything with this, then click **Publish**:

```json
{
  "rules": {
    "rooms": {
      "$code": {
        ".read": "$code.length === 4",
        ".write": "$code.length === 4"
      }
    }
  }
}
```

   This only allows reading/writing a single room by its code. Nobody can list rooms or touch anything else.

4. Copy the database URL shown at the top of the **Data** tab
   (looks like `https://bender-sand-default-rtdb.europe-west1.firebasedatabase.app`).

## 2. Paste it into the game

In `src/net-config.js`:

```js
export const FIREBASE_DB_URL = 'https://bender-sand-default-rtdb.europe-west1.firebasedatabase.app';
```

The URL is public client config, not a password. The rules above are what protect the database.

## 3. Play

- Host: **Host Online** → share the 4-letter code → pick format / win / map → **Start Match**.
- Friends: **Join Online** → type the code, name, bender → **Join**.
- **Tools → Custom** gives the host every painting tool during the online match.

## 4. Relay for blocked networks (TURN)

If joining fails with "Your network blocks direct connections", the two browsers can't reach each
other directly (mobile data, strict routers, school / office Wi-Fi). A TURN relay fixes it:

1. Sign up for a TURN provider with a free tier (for example https://www.metered.ca , "TURN Server").
2. Create a credential and copy the ICE server list it shows (entries with `urls`, `username`, `credential`).
3. Paste those entries into `TURN_SERVERS` in `src/net-config.js`, then push.

The relay is only used when a direct connection fails. Its username / password end up in the page
source (that's how browser TURN works), so anyone could use your free relay allowance; rotate the
credential in the provider's dashboard if that ever happens.

## Known limits

- Without a TURN relay (step 4), some networks can't connect at all.
- The host's upload carries everyone: about 50 KB/s per guest.
- Needs a recent browser (Safari 16.4+ / iOS 16.4+, Chrome, Firefox, Edge).
