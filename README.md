# Intelligent Minecraft NPC Agent

An AI-controlled Minecraft bot built with Node.js and Mineflayer. The bot connects to a Minecraft server, navigates using pathfinding, handles survival/reactive loops, responds to in-game chat, and runs decision-making loops powered by local LLMs (via Ollama) or Claude.

---

## Technical Stack
- **Runtime**: Node.js (v18+)
- **Game client**: [Mineflayer](https://github.com/PrismarineJS/mineflayer)
- **Pathfinding**: [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)
- **LLM Integrations**: Ollama (local) or Anthropic Claude API (production)

---

## Setup Instructions

### 1. Prerequisites
- **Node.js**: Verify you have Node.js installed by running `node -v` (v18 or higher is recommended).
- **Minecraft Server**: A Java Edition server running in **offline-mode**. If using a custom Aternos server, ensure it is online and configured to allow cracked/offline clients.

### 2. Installation
Clone/download this project and install its dependencies inside the project folder:
```bash
npm install
```

### 3. Configuration
1. Copy `.env.example` to a new file named `.env`:
   ```bash
   cp .env.example .env
   ```
2. Edit the `.env` file with your specific target server configuration:
   - `MC_HOST`: The hostname of your Minecraft server (e.g. `BADRX2005-3gTq.aternos.me`)
   - `MC_PORT`: The port number of your Minecraft server (e.g. `50671`)
   - `MC_USERNAME`: The username of the bot (e.g. `Bot_Antigravity`)
   - `MC_VERSION`: Keep empty or set to `false` to auto-negotiate, or enter a specific version if required.

---

## How to Run (Phase 1)

Launch the bot from the project root directory:
```bash
npm start
```
The bot will output connection attempts, status updates, and game/chat events directly to your console.

### In-Game Chat Commands
Once the bot spawns, you can test basic interaction and pathfinding by sending commands in chat:
*   `!status` - Requests the bot to report its position, health, hunger, and inventory contents back to the chat.
*   `!look` - Rotates the bot's head to look directly at your character (must be nearby).
*   `!come` - Commands the bot to calculate a path and walk to your current position.
*   `!goto <x> <y> <z>` - Commands the bot to pathfind to specific coordinates (e.g., `!goto 120 64 -350`).
*   `!stop` - Immediately halts any active movement or pathfinding goals.

---

## Ollama (Local LLM Setup - Phase 2)

During development and testing, the bot's "brain" runs using Ollama locally for zero-cost iterations.

### 1. Download & Install Ollama
Download and run the installer for your operating system:
*   **Windows / macOS**: Download from [ollama.com](https://ollama.com) and run the installer.
*   **Linux**: Run `curl -fsSL https://ollama.com/install.sh | sh`

### 2. Start Ollama
Ensure the Ollama application is running. By default, it runs in the background and hosts a local API at `http://localhost:11434`.

### 3. Pull the Local Model
Open your terminal (PowerShell, Command Prompt, or bash) and pull the recommended model (`llama3.1`). **Note:** A model that natively supports tool-calling (like `llama3.1` or `qwen2.5`) is required for the bot's action selection loop.
```bash
# Pull Llama 3.1 (Recommended)
ollama pull llama3.1
```

### 4. Configuration
Ensure your `.env` contains the correct provider and model settings:
```env
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3.1
OLLAMA_URL=http://localhost:11434

# Decision Loop settings (in milliseconds)
DECISION_INTERVAL_MS=15000
CHAT_DEBOUNCE_MS=1500

# Bot Persona settings
BOT_NAME=Antigravity
BOT_PERSONA=A curious, helpful Minecraft explorer who speaks casually and briefly.
```

### 5. Switch from Ollama to Claude (Later Production Phase)
When you are ready to switch the brain to the Claude API, you do not need to rewrite the code. Just edit your `.env` file:
```env
LLM_PROVIDER=claude
CLAUDE_API_KEY=your_actual_anthropic_api_key
```
The code will dynamically switch communication interfaces based on the `LLM_PROVIDER` environment variable.
