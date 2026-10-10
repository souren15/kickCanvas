# KickCanvas — orders, admin panel and setup

This version of KickCanvas takes real **Cash on Delivery** orders. Every order is saved on the
server with status **Pending Confirmation**, and nothing is confirmed until you approve it in the
admin panel at **/admin**.

It runs entirely on Netlify — no second service or database account:

| Part | What it is |
|---|---|
| Storefront | The same static site (`index.html`, `js/`, `css/`, `assets/`) |
| Server functions | `netlify/functions/*.mjs` — place orders, read order status, admin sign-in, admin actions, settings |
| Database | **Netlify Blobs**, Netlify's built-in storage. Two stores are created automatically on the first write: `kc-orders` and `kc-meta` |
| Admin panel | `admin/index.html` at **/admin** |

---

## Before you deploy: one change to how you upload

Until now you deployed by dragging a zip onto Netlify. **Drag-and-drop deploys don't include server
functions**, so orders and the admin panel would not work. From now on the site deploys from a
GitHub repository linked to your *existing* Netlify site. The address stays
`https://kickcanvas.netlify.app`.

### Step 1 — Put the project on GitHub (once)

1. Sign in at github.com (create a free account if you don't have one).
2. Click **New repository**. Name it `kickcanvas`. Choose **Private**. Don't add a README. Click **Create repository**.
3. On the empty repository page click **uploading an existing file**.
4. Unzip `kickcanvas-deploy-v11.zip` on your computer. Open the unzipped folder, select **everything inside it**
   (including the `netlify`, `admin`, `js`, `css`, `assets`, `scripts` folders and the files `netlify.toml`,
   `package.json`, `_redirects`, `_headers`), and drag it into the GitHub upload area.
   - The project has under 100 files, so one upload is enough.
   - Files whose names start with `_` (`_redirects`, `_headers`) must be included — on a Mac press
     `Cmd + Shift + .` in Finder if they are hidden.
5. Click **Commit changes**.

### Step 2 — Link the repository to your existing Netlify site (once)

1. In Netlify open the **kickcanvas** site.
2. Go to **Site configuration → Build & deploy → Continuous deployment** and choose **Link repository**
   (Netlify may call it "Link site to Git"). Pick GitHub, authorise Netlify, and select the `kickcanvas` repository.
3. Build settings are read from `netlify.toml` automatically. If Netlify asks:
   - Branch: `main`
   - Build command: leave as shown (`echo 'Static site - no build step needed'`)
   - Publish directory: `.`
   - Functions directory: `netlify/functions`
4. Deploy. In the deploy log you should see the functions listed (`orders-create`, `order-status`,
   `site-settings`, `admin-auth`, `admin-orders`, `admin-settings`).

From now on, to update the site you change files in the GitHub repository (upload a changed file
the same way) and Netlify redeploys automatically.

### Step 3 — Create the administrator account

The admin password is never stored in any file. Netlify keeps a one-way hash of it as an
environment variable, and sign-in is checked on the server.

1. After the first Git deploy, open **https://kickcanvas.netlify.app/admin/setup.html**.
2. Type a password of at least 12 characters twice and click **Create hash**. This happens only
   in your browser — the password is not sent anywhere.
3. In Netlify go to **Site configuration → Environment variables → Add a variable** and add these
   three (scope: at least **Functions**):

   | Key | Value |
   |---|---|
   | `ADMIN_USERNAME` | the username you want, e.g. `anushka` |
   | `ADMIN_PASSWORD_HASH` | the long value starting `pbkdf2-sha256$…` from the setup page |
   | `SESSION_SECRET` | the random value from the setup page (at least 32 characters) |

4. Go to **Deploys → Trigger deploy → Deploy site**. Environment variables only take effect after a new deploy.
5. Open **https://kickcanvas.netlify.app/admin** and sign in.

Alternative to the setup page, if you have Node.js installed: run `node scripts/hash-password.mjs`
in the project folder.

**Changing the password:** make a new hash on the setup page, replace `ADMIN_PASSWORD_HASH`, redeploy.
**Signing everyone out:** change `SESSION_SECRET` and redeploy.

---

## Check it works (5 minutes, after Step 3)

1. Open the store on your phone, design a pair, **Add to cart → Checkout**, fill in the form and
   tap **Place order**. You should see "Your order has been placed successfully and is awaiting
   confirmation from KickCanvas." with an order ID.
2. Open **/admin** on your laptop and sign in. The order is in the **orders need your confirmation** queue.
3. Click **Approve**. On your phone open **Track order** — the status reads **Confirmed**.
4. In the admin, open the order and move it to **Processing → Shipped → Delivered**.
5. Place a second order and **Reject** it with a reason; the customer's Track page shows the reason.

Also do this once for GA4 (from the earlier analytics fix): **GA4 Admin → Data streams → your stream
→ Enhanced measurement → ⚙ → turn off "Page changes based on browser history events"**.

---

## How it works

### Order flow
1. The customer customises a sneaker, adds it to the cart, and places a **Cash on Delivery** order
   (the only payment method — no card, UPI or online payment exists anywhere in the site).
2. The server checks every field, **re-prices every item from its own product data** (prices sent by
   the browser are ignored), applies the coupon, shipping and free-shipping rule, and saves the order
   with status **Pending Confirmation**.
3. The customer sees the order ID, date and time, items, total, payment method and status. Their cart
   is cleared only after the server confirms the save; if saving fails they see an error and keep their cart.
4. You approve or reject it in the admin panel. Approved orders move through Processing → Shipped →
   Delivered. Each change is saved with who made it and when.
5. The customer's **Track order** page always shows the latest saved status.

### Allowed status changes

| From | Can move to |
|---|---|
| Pending Confirmation | Confirmed, Rejected, Cancelled |
| Confirmed | Processing, Cancelled |
| Processing | Shipped, Cancelled |
| Shipped | Delivered |
| Delivered, Rejected, Cancelled | — (final) |

Only a signed-in administrator can change a status. Customers can only read their own order.

### What you can change from the admin panel (no code edits)

- **Products:** name, price, description, *Show on website*, *Can be ordered*.
  Hidden products disappear from the collection and the configurator. Products that can't be ordered
  stay visible but show "Not available right now".
- **Website:** announcement bar, hero badge, both hero heading lines, hero text, the promotional
  banner heading and text.
- **Orders:** accept new orders on/off (with the message customers see when off), the order-received
  heading and message, shipping charge, free-shipping threshold.

Changes are saved as a **draft**. **Preview** opens the real site showing your draft (only you can see
it). **Publish** makes it live for everyone. **Discard draft** goes back to what is live.

### Data model (Netlify Blobs — no migrations needed)

`kc-orders` store, one record per order, key `o/<ORDER ID>`:

```
id            "KC-7H2KQ9XM"
createdAt     ISO time
updatedAt     ISO time
status        pending | confirmed | rejected | processing | shipped | delivered | cancelled
history       [{ status, at, by: "customer" | <admin username>, note }]
customer      { name, email, phone, address, apt, city, state, pincode }
items         [{ model, name, size, qty, pairMode, finish, finishLabel, unitPrice, lineTotal,
                 design: { left: { parts: { <part>: { color } }, decals: [{ type, text? }] }, right },
                 summary: { left, right }, preview }]       // preview = small PNG of the design
totals        { subtotal, discount, shipping, total }
coupon        "KICK10" | null
paymentMethod "Cash on Delivery"
tokenHash     SHA-256 of the private token the customer's browser uses to read its own order
```

`kc-meta` store:

```
settings/live      the published site settings
settings/draft     the unpublished draft
idem/<key>         duplicate-submission guard (one per order attempt)
rl/<kind>/<hash>   rate-limit counters (sign-in attempts, orders, tracking look-ups)
```

### Security summary

- Admin password stored only as a PBKDF2-SHA256 hash (310,000 iterations) in a Netlify environment variable.
- Sign-in sets an HMAC-signed, `HttpOnly`, `Secure`, `SameSite=Strict` cookie that expires after 8 hours.
- Every admin read and write checks that cookie on the server; changes also require a same-origin request
  with a custom header (protects against cross-site request forgery).
- 5 wrong passwords lock sign-in from that network for 15 minutes.
- Customer addresses and phone numbers are only returned to the signed-in admin. A customer can read
  their own order with their private token (stored in their browser) or with the order ID **plus** the email used.
  There is no endpoint that lists orders publicly.
- Order creation: server-side validation of every field, server-side pricing, product/size/quantity checks,
  duplicate-submission protection, and a limit of 30 orders per hour per network address.
- `/admin` is excluded from search engines; the server code, `package.json`, `netlify.toml`, `scripts/` and
  this file return 404 if requested from the website.

---

## Troubleshooting

| You see | Cause | Fix |
|---|---|---|
| Checkout says the order service isn't running | The site was deployed by drag-and-drop | Deploy from GitHub (Steps 1–2) |
| /admin says the admin account isn't set up | Environment variables missing or not redeployed | Step 3, then **Trigger deploy** |
| "Too many sign-in attempts" | 5 wrong passwords | Wait 15 minutes |
| Price change not showing to customers | Saved as draft only | Click **Publish** |
| Old "Coming soon" preview when sharing the link on WhatsApp | WhatsApp caches link previews | The image link was updated; new shares refresh within a few days |

## Not included

- **No emails or SMS.** Customers check status on the Track order page. You can call or email them from the
  links in the order details.
- **One administrator account** (one username/password).
- The fake Razorpay code and the "demo payment" button were removed completely.
