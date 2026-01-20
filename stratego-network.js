export class StrategoNetwork {
  constructor({ baseUrl }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.wsUrl = this.baseUrl
      .replace("https://", "wss://")
      .replace("http://", "ws://");

    this.userId = null;
    this.username = null;

    this.sse = null;
    this.ws = null;

    this.handlers = {
      lobbyUpdate: new Set(),
      lobbyChat: new Set(),
      challengeReceived: new Set(),
      challengeAnswered: new Set(),
      matchStarted: new Set(),
      opponentMoved: new Set(),
      combatResult: new Set(),
      illegalMoveDetected: new Set(),
      matchChatMessage: new Set(),
      gameOver: new Set(),
      matchCancelled: new Set(),
      rematchStarted: new Set(),
      error: new Set(),
      debug: new Set(),
    };
  }

  on(eventName, fn) {
    const set = this.handlers[eventName];
    if (!set) throw new Error(`Unknown network event: ${eventName}`);
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(eventName, payload) {
    const set = this.handlers[eventName];
    if (!set) return;
    set.forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        // Avoid killing the UI due to one listener
        console.error(e);
      }
    });
  }

  getAuthHeaders() {
    if (!this.userId) return {};
    // API allows Authorization Bearer or X-USER-ID
    return {
      "X-USER-ID": this.userId,
    };
  }

  async fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return res;
    } finally {
      clearTimeout(t);
    }
  }

  async createSession(username, { timeoutMs = 8000 } = {}) {
    let res;
    try {
      res = await this.fetchWithTimeout(
        `${this.baseUrl}/api/sessions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username }),
        },
        timeoutMs
      );
    } catch (e) {
      // AbortError => timeout
      const reason =
        e?.name === "AbortError"
          ? `Timeout (${timeoutMs}ms) conectando a ${this.baseUrl}`
          : `Fetch error conectando a ${this.baseUrl}: ${String(e)}`;
      throw new Error(`Session create failed: ${reason}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Session create failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    this.userId = data.userId;
    this.username = data.username;
    return data;
  }

  async ensureSession({ storageKey = "stratego.session" } = {}) {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.userId && parsed?.username) {
          this.userId = parsed.userId;
          this.username = parsed.username;
          return { userId: this.userId, username: this.username, reused: true };
        }
      } catch {
        // ignore corrupted storage
      }
    }
    return { reused: false };
  }

  persistSession({ storageKey = "stratego.session" } = {}) {
    if (!this.userId || !this.username) return;
    localStorage.setItem(
      storageKey,
      JSON.stringify({ userId: this.userId, username: this.username })
    );
  }

  connectSse() {
    if (!this.userId) throw new Error("Cannot connect SSE without userId");

    if (this.sse) {
      try {
        this.sse.close();
      } catch {}
    }

    const url = `${this.baseUrl}/api/events/stream?userId=${encodeURIComponent(
      this.userId
    )}`;

    const es = new EventSource(url);
    this.sse = es;

    // Generic message handler (server sends named events)
    const bind = (eventName, mappedName) => {
      es.addEventListener(eventName, (evt) => {
        try {
          const data = JSON.parse(evt.data);
          this.emit(mappedName, data);
        } catch (e) {
          this.emit("error", { where: "sse", eventName, error: String(e) });
        }
      });
    };

    // Lobby presence
    bind("lobby_update", "lobbyUpdate");

    // Matchmaking + game events (we’ll use them in later steps, but safe to bind now)
    bind("challenge_received", "challengeReceived");
    bind("challenge_answered", "challengeAnswered");
    bind("match_started", "matchStarted");
    bind("opponent_moved", "opponentMoved");
    bind("combat_result", "combatResult");
    bind("illegal_move_detected", "illegalMoveDetected");
    bind("match_chat_message", "matchChatMessage");
    bind("game_over", "gameOver");
    bind("match_cancelled", "matchCancelled");
    bind("rematch_started", "rematchStarted");

    es.onerror = () => {
      this.emit("error", { where: "sse", error: "SSE connection error" });
    };

    return es;
  }

  connectWs() {
    if (!this.userId) throw new Error("Cannot connect WS without userId");

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return this.ws;
    }

    // The docs specify path: /gateway. Auth mechanism is not explicitly shown,
    // so we pass userId as query (common pattern in this course server).
    const url = `${this.wsUrl}/gateway?userId=${encodeURIComponent(this.userId)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => this.emit("debug", { where: "ws", message: "WS open" });
    ws.onerror = () => this.emit("error", { where: "ws", error: "WebSocket error" });
    ws.onclose = () => this.emit("debug", { where: "ws", message: "WS closed" });

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);

        // We accept either {event: "..."} or {type: "..."} just in case.
        const event = msg.event || msg.type;

        if (event === "lobby_chat_message") {
          this.emit("lobbyChat", msg);
          return;
        }

        // Many servers forward game events also through WS depending on protocolMode
        // so we map a few common ones:
        const map = {
          lobby_update: "lobbyUpdate",
          challenge_received: "challengeReceived",
          challenge_answered: "challengeAnswered",
          match_started: "matchStarted",
          opponent_moved: "opponentMoved",
          combat_result: "combatResult",
          illegal_move_detected: "illegalMoveDetected",
          match_chat_message: "matchChatMessage",
          game_over: "gameOver",
          match_cancelled: "matchCancelled",
          rematch_started: "rematchStarted",
        };

        if (event && map[event]) {
          this.emit(map[event], msg.payload ?? msg);
          return;
        }

        // fallback for unexpected messages
        this.emit("debug", { where: "ws", message: "Unmapped WS message", msg });
      } catch (e) {
        this.emit("error", { where: "ws", error: `WS message parse failed: ${String(e)}` });
      }
    };

    return ws;
  }

  sendWs(eventName, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    // Message envelope: { event: "send_lobby_chat", ...payload }
    this.ws.send(JSON.stringify({ event: eventName, ...payload }));
    return true;
  }

  sendLobbyChat(content) {
    // Lobby chat is ALWAYS WebSocket per spec
    return this.sendWs("send_lobby_chat", { content });
  }

  // =============================
  // Matchmaking (PvP/PvE)
  // =============================

  /**
   * Picks the protocolMode randomly as required by the assignment (50/50).
   * @returns {"FETCH_FIRST"|"SOCKET_FIRST"}
   */
  pickRandomProtocolMode() {
    return Math.random() < 0.5 ? "FETCH_FIRST" : "SOCKET_FIRST";
  }

  /**
   * POST /api/challenges
   */
  async createChallenge(
    { targetUserId, mode, protocolMode },
    { timeoutMs = 8000 } = {}
  ) {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/challenges`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.getAuthHeaders(),
        },
        body: JSON.stringify({ targetUserId, mode, protocolMode }),
      },
      timeoutMs
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Challenge create failed (${res.status}): ${text}`);
    }

    return res.json();
  }

  /**
   * PATCH /api/challenges/{challengeId}
   */
  async answerChallenge(
    { challengeId, answer },
    { timeoutMs = 8000 } = {}
  ) {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/challenges/${encodeURIComponent(challengeId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...this.getAuthHeaders(),
        },
        body: JSON.stringify({ challengeId, answer }),
      },
      timeoutMs
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Challenge answer failed (${res.status}): ${text}`);
    }

    const t = await res.text().catch(() => "");
    try {
      return t ? JSON.parse(t) : { ok: true };
    } catch {
      return { ok: true };
    }
  }

  /**
   * POST /api/matches/{matchId}/setup
   */
  async sendSetup({ matchId, pieces }, { timeoutMs = 8000 } = {}) {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/matches/${encodeURIComponent(matchId)}/setup`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.getAuthHeaders(),
        },
        body: JSON.stringify({ pieces }),
      },
      timeoutMs
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Setup send failed (${res.status}): ${text}`);
    }

    const t = await res.text().catch(() => "");
    try {
      return t ? JSON.parse(t) : { ok: true };
    } catch {
      return { ok: true };
    }
  }
}

