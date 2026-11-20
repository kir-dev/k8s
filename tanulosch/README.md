
# TanuloSCH

> **Maintenance Rule:** Update this documentation whenever infrastructure, configuration, dependencies, or deployment workflows change.
> **Last Updated:** 2026-11-14 by @Tschonti

---

## 1. Overview & Public URLs

- **Repository:** [github.com/kir-dev/tanulo-next](https://github.com/kir-dev/tanulo-next)
- **Production URL(s):** [TanuloSCH](https://tanulo.sch.bme.hu/)

---

## 2. Deployment Documentation

### Services Used
| Component | Technology / Service | Purpose |
| :--- | :--- | :--- |
| **Frontend** | Pug| HTML templating |
| **Backend** | express.js | REST API |
| **Database** | PostgreSQL 12 💀 | Primary data store |
| **Auth** |  AuthSCH | Authentication  |
| **Email** |  KSZK SMTP server (`mail.sch.bme.hu`)| Email sending|

### Where It Is Currently Running
- **Host / Environment:** Lois (`/home/deploy/tanulo-next`)

### Configuration Files
- **Repository Configs:** [`docker-compose.yml`](https://github.com/kir-dev/tanulo-next/blob/master/docker-compose.yml), [`Dockerfile`](https://github.com/kir-dev/tanulo-next/blob/master/Dockerfile)
- **Server / Runtime Config Location:** `.env` file in the project folder on Lois

### Step-by-Step Deployment Instructions

1. **Connect to the host, switch to deploy user and navigate to the project directory:**
   ```bash
   ssh ...
   sudo su deploy
   cd ~/tanulo-next
   ```

2. **Pull the latest changes and verify environment variables:**
   ```bash
   git fetch origin
   git checkout master
   git pull origin master
   # Compare .env against .env.example for any newly added keys
   diff -u <(cut -d= -f1 .env.example | sort) <(cut -d= -f1 .env | sort)
   ```

3. **Build and start the updated services:**
   ```bash
   docker compose pull
   docker compose build --no-cache
   docker compose up -d
   ```

4. **Run database migrations and verify health:**
   ```bash
   docker compose exec konzisite-api-web-1 npm run migrate
   docker compose ps
   curl -I https://tanulo.sch.bme.hu/
   ```


---

## 3. Update & Upgrade Documentation

### Known Incompatibilities


### Deliberate Version Pins


### Order of Operations for Updates & Upgrades
