<img style="width: 128px; height: 128px" src="website/static/favicon.svg" /><h1 style="font-size: 48px">Rugplay: Stock Market Edition</h1>

A fork of [Rugplay](https://github.com/outpoot/rugplay), the fake crypto simulator, that adds a **stock market**, **player-founded startups** and an **AI crowd** that trades like the mass of real people.

> 🚧 **Early version.** Stock market v1 is built but not playtested yet, so numbers will change. Plan and decisions: [docs/STOCK_MARKET_PLAN.md](docs/STOCK_MARKET_PLAN.md)

## About

Rugplay lets you experience crypto trading, liquidity pools and "rug pulls" without real money. This fork puts a **real-ish stock market** next to it: companies with revenue, profit and cash, where hype alone isn't enough.

The goal is to be **fun and educational** (mainly for teens/students) without lectures: bubbles, crashes and hype-vs-fundamentals happen on their own, and you learn by playing (and getting burned).

## Stock market features

- 🏢 **Found a startup:** pick a sector, write a pitch, set a valuation and sell shares in a 3-day funding round
- 📊 **Daily earnings:** every "quarter" (1 real day) your company spends cash and earns revenue based on your spending level, the sector and luck. Run out of cash and you go bankrupt
- 📈 **IPO + order book:** when the round ends, the company goes public and its shares trade with limit and market orders. Founder shares unlock over 14 days
- 📣 **Founder news:** post updates and promises ("profit next report"). Broken promises lower your trust score, and the crowd stops believing you
- 🤖 **AI crowd:** three bots (retail, fund, trader) see different info and turn their buy/sell/hold odds into real trades. They run on a local LLM (llama.cpp) or built-in rules
- 🌡️ **Crowd mood + "why did the price move?":** see what each crowd type thinks, and what caused big price moves
- 🪙 **Crypto stays:** coins keep the AMM; admins can let the crowd trade them too (`/admin/crowd`)

## Coming next: Real Market mode

Trade real stocks and crypto at real prices with virtual money, compete in leagues ranked by % return, and try to beat simply holding the market (SPY). See the [plan](docs/STOCK_MARKET_PLAN.md#real-market-mode-planned).

## Original Rugplay features
- 🪙 Create, buy and sell coins
- ⚖️ Predict on questions (similar to Polymarket)
- 🎲 Play arcade games
- 📊 View a Treemap graph of the entire market
- 🏆 Compete on leaderboards

![Preview 2](github_assets/preview2.png)
![Preview](github_assets/preview.png)

## Development Setup

### Prerequisites

Before you begin, make sure you have the following installed:

- [Node.js](https://nodejs.org/) (LTS version recommended)
- [Bun](https://bun.sh/) (for websocket server)
- [Docker](https://www.docker.com/) (for running Redis and PostgreSQL)

### Getting Started

1. **Clone the repository**

   ```bash
   git clone https://github.com/combustion-robotics/rugplay.git
   cd rugplay
   ```

2. **Set up Redis**

   Create a Redis Docker container:
   ```bash
   docker run -d --name rugplay-redis -p 6379:6379 -v rugplay_redisdata:/data --restart unless-stopped redis:8-alpine redis-server --save 60 1
   ```

   **Alternative:** You can also [download and install Redis directly](https://redis.io/downloads/) for your operating system, or use a managed Redis service such as Redis Cloud.

3. **Set up PostgreSQL**

   You have two main options for your Postgres database:

   - **Run Postgres locally with Docker:**
     ```bash
     docker run -d --name rugplay-postgres -e POSTGRES_USER=pguser -e POSTGRES_PASSWORD=pgpass -e POSTGRES_DB=rugplay -p 5432:5432 -v rugplay_pgdata:/var/lib/postgresql/data --restart unless-stopped pgvector/pgvector:pg16
     ```

   - **Use a managed cloud Postgres provider:**
     Services like [Supabase](https://supabase.com/), [Neon](https://neon.tech/), or others let you create a Postgres database online, often with a free tier. Simply grab your connection details (host, user, password, database name) from your provider.

   After your database is running, update your `DATABASE_URL` in the `.env` file to point to your Postgres instance.

   If you are running Postgres locally, you can seed the database with:
   ```bash
   docker exec -it rugplay-postgres psql -d rugplay -U pguser
   ```
   Then, copy and paste the SQL from the migration files (e.g. `website/drizzle/0000_crazy_bloodstrike.sql`).

4. **Configure Google OAuth**

   - Go to [Google Auth Platform dashboard](https://console.cloud.google.com/auth/clients)
   - Create a new client:
     - Application type: "Web application"
     - Name: Your choice
     - Authorized JavaScript origins: Can be left empty
     - Authorized redirect URIs:
       - http://localhost:3002/api/auth/callback/google
       - http://localhost:5173/api/auth/callback/google
       - Production URL

5. **Configure Environment Variables**

   ```bash
   cd website
   cp .env.example .env
   ```

   Edit `.env` with your values. Example:

   ```ini
   # --- Database ---
   DATABASE_URL=postgres://pguser:pgpass@localhost:5432/rugplay   # PostgreSQL connection string
   POSTGRES_USER=pguser      # PostgreSQL username (should match Docker config)
   POSTGRES_PASSWORD=pgpass  # PostgreSQL password (should match Docker config)
   POSTGRES_DB=rugplay       # PostgreSQL database name (should match Docker config)

   # --- Redis ---
   REDIS_URL=redis://localhost:6379  # Redis connection string

   # --- Auth ---
   PRIVATE_BETTER_AUTH_SECRET=your_secret_here   # Any alphanumeric string for session encryption
   PUBLIC_BETTER_AUTH_URL=http://localhost:5173  # For development, use http://localhost:5173. For production, use http://localhost:3002

   # --- Google OAuth ---
   GOOGLE_CLIENT_ID=your_google_client_id
   GOOGLE_CLIENT_SECRET=your_google_client_secret

   # --- Websocket ---
   PUBLIC_WEBSOCKET_URL=ws://localhost:8080      # URL of the websocket server

   # --- Optional: AWS (for additional features) ---
   AWS_ACCESS_KEY_ID=your_aws_access_key
   AWS_SECRET_ACCESS_KEY=your_aws_secret_key
   AWS_REGION=us-east-1

   # --- Optional: OpenRouter (for AI features) ---
   OPENROUTER_API_KEY=your_openrouter_api_key

   # --- Optional: local LLM for the AI crowd (llama.cpp server) ---
   CROWD_LLM_URL=http://localhost:8080   # leave empty to use the built-in rules
   CROWD_LLM_MODEL=local
   ```

   **Notes:**
   - For production, change `PUBLIC_BETTER_AUTH_URL` to `http://localhost:3002` or your deployed domain.
   - The `DATABASE_URL` should match your Postgres Docker container settings.
   - The `REDIS_URL` should match your Redis Docker container settings.
   - AWS and OpenRouter variables are optional and only needed for advanced features.

6. **Install Dependencies**

   Set up the websocket server:
   ```bash
   cd website/websocket
   bun install
   ```

   Set up the main website:
   ```bash
   cd ../
   npm install --include=dev
   ```

### Running the Application

1. **Start the websocket server**

   ```bash
   cd website/websocket
   bun run src/main.ts
   ```

2. **Start the main website (Development Mode)**

   In a new terminal:
   ```bash
   cd website
   npm run dev
   ```

   The development server will be available at http://localhost:5173

### Production Deployment

#### Using Docker (Recommended)

1. **Build and start with Docker:**

    ```bash
    ./build.sh
    ```

    This will automatically start all required services, including the Database, Redis and the websocket server, as Docker containers. You do not need to run the websocket server manually when using Docker Compose for deployment.

2. The app will be available at http://localhost:3002

#### Manual Deployment

1. **Build the website:**

    ```bash
    cd website
    npm run build
    npm run preview
    ```

2. **Start the websocket server:**

    ```bash
    cd website/websocket
    bun run src/main.ts
    ```

## Credits

Based on [Rugplay](https://github.com/outpoot/rugplay) by outpoot ([rugplay.com](https://rugplay.com), [YouTube video](https://www.youtube.com/watch?v=nRUkvPMphRc)).

## License

This project is licensed under the **Creative Commons Attribution-NonCommercial 4.0 International** License (**CC BY-NC 4.0**). See the [LICENSE](LICENSE) file for details.
