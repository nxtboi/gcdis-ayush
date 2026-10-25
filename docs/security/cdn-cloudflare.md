# Putting Cloudflare in front of GCDIS (go-live guide)

Cloudflare's free plan adds what the server alone cannot: absorbing large DDoS floods before they reach
the VPS, filtering obvious bots, and caching static files close to visitors. The application's own
protections (rate limits, lockouts, CSP, signed links) stay exactly as they are.

Done right, nothing else changes for visitors. Done wrong, the most common mistake is that every visitor
appears to come from a Cloudflare address, so one person can exhaust everyone's rate limit, the admin
allow-list stops working, and audit logs show Cloudflare instead of the real client. Step 4 prevents that.

## 1. Add the site
1. Create a Cloudflare account, **Add a site**, choose the **Free** plan.
2. Cloudflare imports the DNS records. Check that `www`, the apex, `admin` and `api` all point at the VPS.
3. At the domain registrar, change the nameservers to the two Cloudflare gives you. Wait until the site
   shows **Active**.

## 2. Proxy the web hosts
- Set the cloud icon to **Proxied (orange)** for `www`, the apex and `api`.
- `admin`: either proxied as well (recommended, then rely on the admin IP allow-list from
  `production-checklist.md`), or **DNS only (grey)** if staff connect over a VPN to the VPS directly.
- Keep any mail records (MX, SPF, DKIM, DMARC for Brevo) **DNS only**.

## 3. TLS
- **SSL/TLS → Overview → Full (strict)**. Never "Flexible": it would send traffic between Cloudflare and
  the server unencrypted and make the site redirect in a loop.
- The existing Let's Encrypt certificates on nginx keep working (HTTP-01 renewals pass through the proxy).
- **Edge Certificates:** Always Use HTTPS = on, Minimum TLS = 1.2, TLS 1.3 = on, Automatic HTTPS Rewrites
  = on. Leave **HSTS off in Cloudflare**: nginx already sends it (2 years, preload), and two sources of
  HSTS settings drift apart.

## 4. Real visitor IP (required)
nginx currently treats the connecting address as the visitor, which is correct only without a proxy.
Behind Cloudflare it must read Cloudflare's `CF-Connecting-IP` header, **and trust it only from
Cloudflare's own address ranges** (otherwise anyone could fake their IP by sending that header).

1. Enable the prepared file `infra/nginx/cloudflare-realip.conf`: uncomment its lines, refresh the address
   ranges from https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6, and add
   `include /etc/nginx/cloudflare-realip.conf;` inside the `http { }` block of `nginx.conf`
   (mount it in `docker-compose.prod.yml` next to the other nginx files).
2. `docker compose exec proxy nginx -t && docker compose exec proxy nginx -s reload`.
3. Check: sign in to the staff console, open **Security → sessions**; the IP shown must be your own
   address, not a Cloudflare one (Cloudflare ranges start with e.g. 104.16, 172.64, 162.158).

The API needs no change: it trusts exactly one proxy hop (nginx), and nginx passes the corrected address
on in `X-Real-IP` / `X-Forwarded-For`.

## 5. Accept traffic only from Cloudflare
Otherwise an attacker who finds the VPS address skips Cloudflare entirely.
- In the VPS firewall (e.g. `ufw`), allow ports 80 and 443 **only** from the Cloudflare ranges above,
  plus SSH from your own address. If `admin` is left DNS-only, also allow 443 from the staff/VPN range.
- Re-check the ranges every few months (Cloudflare publishes changes in advance).

## 6. Protection settings (free plan)
- **Security → Bots:** Bot Fight Mode = on.
- **Security → Settings:** Security Level = Medium; Browser Integrity Check = on.
- **Security → WAF → Rate limiting rules** (free plan allows one rule): path starts with `/api/auth/`,
  more than 20 requests per 10 seconds per IP → Block for 10 seconds. This sits in front of the API's own
  limits and stops floods before they reach the server.
- **Network:** WebSockets = on (live scoreboard).
- **Under attack:** Security → Settings → "I'm Under Attack Mode" shows visitors a short check page.
  Use it only during an active attack; it can interrupt the Razorpay webhook, so add a WAF **Skip** rule for
  `POST /api/payments/webhook` first (Razorpay retries failed webhooks, but don't rely on it).

## 7. Caching (avoid caching private data)
Cloudflare caches only static file types by default, which is what we want. Add one **Cache Rule**:
- If hostname is `api.<domain>` **or** the path starts with `/portal` or `/api` → **Bypass cache**.

Never enable "Cache Everything" on these hosts: pages and API responses contain signed-in users' data.

## 8. Verify after switching
- `curl -sI https://www.<domain>` shows `server: cloudflare` and still carries the site's own headers
  (Content-Security-Policy, Strict-Transport-Security, X-Frame-Options).
- Sign in to the portal and the staff console; pay a test entry fee; open a private document link.
- Watch `/api/csp-report` log lines and the API log for unexpected 429s during the first day.

## Rolling back
Set the DNS records back to **DNS only (grey)**. Traffic goes straight to nginx again within minutes.
Comment out the `cloudflare-realip.conf` include and reload nginx, and remove the firewall restriction to
Cloudflare ranges.
