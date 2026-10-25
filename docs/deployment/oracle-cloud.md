# Hosting GCDIS on Oracle Cloud Always Free

Oracle Cloud's Always Free tier includes an ARM (Ampere A1) server with up to **4 CPUs and 24 GB RAM**,
200 GB of disk and 10 TB of traffic a month, at no cost. That comfortably runs the full production stack
(website, staff console, API, PostgreSQL, Redis, ClamAV, nginx with HTTPS, backups). All images used by the
stack support ARM, and CI builds the GCDIS images for both `amd64` and `arm64`.

This guide covers the server. For secrets, the first deploy and the content steps, continue with
[`go-live.md`](go-live.md) from section 2.

## 1. Create the account
1. Sign up at https://signup.cloud.oracle.com. A debit or credit card is needed for identity
   verification only; Always Free resources are not charged.
2. **Home region:** choose it carefully, it cannot be changed. For India pick **India West (Mumbai)** or
   **India South (Hyderabad)**. If ARM capacity is often unavailable there, any region works; pick the
   nearest one with capacity.
3. Optional but recommended: upgrade to **Pay As You Go** (still free for Always Free resources). It makes
   ARM capacity much easier to get and stops idle-instance reclamation. Set a **budget alert of ₹100**
   (Billing → Budgets) so you are warned if anything chargeable is ever created.

## 2. Create the server
Console → **Compute → Instances → Create instance**:

| Setting | Value |
|---|---|
| Name | `gcdis-prod` |
| Image | **Canonical Ubuntu 24.04** (aarch64) |
| Shape | **Ampere → VM.Standard.A1.Flex**, **4 OCPUs, 24 GB memory** |
| Networking | Create a new VCN with a public subnet; **Assign a public IPv4 address** |
| SSH keys | Upload your own public key (or let Oracle generate one and **save the private key**) |
| Boot volume | 100–200 GB (the free tier includes 200 GB in total) |

If you see "Out of capacity for shape", retry later or try another availability domain; capacity is
released frequently.

After creating it, make the public IP permanent: Instance → **Attached VNICs → IPv4 addresses →
Edit → Reserved public IP** (free).

## 3. Open the web ports (two places)
1. **Oracle firewall (Security List):** Networking → Virtual Cloud Networks → your VCN → the subnet's
   Security List → **Add Ingress Rules**: source `0.0.0.0/0`, TCP, destination ports **80** and **443**.
   Port 22 is already open; restrict it to your own IP if possible.
2. **Ubuntu's own firewall:** Oracle's Ubuntu images block everything except SSH with iptables. On the
   server:
   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

## 4. Prepare the server
SSH in: `ssh ubuntu@<public-ip>`. Then:
```bash
sudo apt update && sudo apt -y upgrade
# Docker Engine + compose plugin (official convenience script)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker
# 4 GB swap as a safety net
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
# Automatic security updates
sudo apt -y install unattended-upgrades && sudo dpkg-reconfigure -f noninteractive unattended-upgrades
```
Then disable SSH password login (keys only) in `/etc/ssh/sshd_config` (`PasswordAuthentication no`) and
`sudo systemctl restart ssh`.

## 5. Domain (DNS)
At your domain's DNS provider, create **A records** pointing to the reserved public IP:
`gcdis.in`, `www.gcdis.in`, `admin.gcdis.in`, `api.gcdis.in`. Keep them DNS-only until the site works;
see [`../security/cdn-cloudflare.md`](../security/cdn-cloudflare.md) before enabling Cloudflare's proxy.

## 6. Connect GitHub to the server
1. On the server, create a deploy key for pulling the private repository:
   `ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N ""` and add `~/.ssh/github_deploy.pub` in GitHub →
   repository → **Settings → Deploy keys** (read-only).
2. Clone: `GIT_SSH_COMMAND="ssh -i ~/.ssh/github_deploy" git clone git@github.com:AyushPandey9569/GCDIS-Website-.git /srv/gcdis`
3. Log in to GitHub's container registry with a **read:packages** token:
   `docker login ghcr.io -u AyushPandey9569`
4. For automatic deploys from GitHub Actions, create a separate key pair for Actions to SSH in, add its
   public key to `~/.ssh/authorized_keys` on the server, and set these in GitHub → **Settings →
   Environments → production**: `DEPLOY_HOST` (the public IP), `DEPLOY_USER` (`ubuntu`),
   `DEPLOY_PATH` (`/srv/gcdis`), `DEPLOY_SSH_KEY` (the private key), `DEPLOY_KNOWN_HOSTS`
   (output of `ssh-keyscan <public-ip>`).

## 7. Continue with the go-live guide
From here follow [`go-live.md`](go-live.md): create the production `.env` (section 2), first deploy,
seed, super admin, TLS certificates, content, and the smoke test.

## Notes
- **First ARM build:** CI builds the images for ARM under emulation, so the first pipeline run after this
  change takes longer (about 20–40 minutes). Later runs use the build cache.
- **Resource use:** the compose limits total about 10.5 GB, well within 24 GB.
- **Backups:** Oracle's free tier includes 20 GB of Object Storage, which is S3-compatible and can be used
  for the off-site backups (`BACKUP_S3_BUCKET` with an Oracle "Customer Secret Key").
- **Idle reclamation:** Oracle may reclaim Always Free instances that stay almost idle for 7 days. A live
  website with visitors and daily backups is normally enough activity; upgrading to Pay As You Go removes
  the risk entirely.
