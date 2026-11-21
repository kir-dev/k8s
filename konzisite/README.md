
# Konzisite

> **Maintenance Rule:** Update this documentation whenever infrastructure, configuration, dependencies, or deployment workflows change.
> **Last Updated:** 2026-11-14 by @Tschonti

---

## 1. Overview & Public URLs

- **Frontend Repository:** [github.com/kir-dev/konzisite-frontend](https://github.com/kir-dev/konzisite-frontend)
- **Backend Repository:** [github.com/kir-dev/konzisite-api](https://github.com/kir-dev/konzisite-api)
- **Production URL(s):** [Frontend](https://konzi.vik.hk/), [Backend](https://api.konzisite.kir-dev.hu/)

---

## 2. Deployment Documentation

### Services Used
| Component | Technology / Service | Purpose |
| :--- | :--- | :--- |
| **Frontend** | React | Web UI |
| **Backend** | NestJS| REST API |
| **Database** | PostgreSQL 13 | Primary data store |
| **Auth** |  AuthSCH| Authentication  |

### Where It Is Currently Running
- **Host / Environment:** Backend: Lois (`/home/deploy/konzisite-api`), Frontend: Vercel

### Configuration Files
- **Repository Configs:** [`docker-compose.yml`](https://github.com/kir-dev/konzisite-api/blob/master/docker-compose.yml), [`Dockerfile`](https://github.com/kir-dev/konzisite-api/blob/master/Dockerfile)
- **Server / Runtime Config Location:** `.env` file in the project folder on Lois
- **GUI Platform Settings:** [Vercel Project Settings](https://vercel.com/kir-dev/konzisite-frontend)

### Step-by-Step Deployment Instructions

1. **Connect to the host, switch to deploy user and navigate to the project directory:**
   ```bash
   ssh ...
   sudo su deploy
   cd ~/konzisite-api
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
   docker compose exec konzisite-api-web-1 npx prisma migrate deploy
   docker compose ps
   curl -I https://api.konzisite.kir-dev.hu
   ```


---

## 3. Update & Upgrade Documentation

### Known Incompatibilities


### Deliberate Version Pins


### Order of Operations for Updates & Upgrades
