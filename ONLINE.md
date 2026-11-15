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

## Known limits

- No TURN relay server: on some strict networks (some mobile carriers, school/office Wi-Fi)
  browsers can't reach each other directly, and joining fails with "Could not connect to the host".
- The host's upload carries everyone: about 50 KB/s per guest.
- Needs a recent browser (Safari 16.4+ / iOS 16.4+, Chrome, Firefox, Edge).
