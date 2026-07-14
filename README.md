Quick Start

Minimal commands to set up and run the app.

```bash
# Install dependencies
npm install

# Create .env (copy from example if present)
# macOS / Linux
cp .env.example .env
# PowerShell (Windows)
copy .env.example .env

# Docker 
docker-compose up 

# Run DB migrations
npm run db:migrate

# start drizzle studio gui
npx drizzle-kit studio

# view database
https://local.drizzle.studio

# Start dev server
npm run dev

# postman
 "In postman's setting make sure cookie jar is enabled"

# during signup and login 
"the otp and email verification link will be printed to console (in development)"



```
