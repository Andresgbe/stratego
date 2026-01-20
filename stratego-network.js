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

    // Matchmaking + game events
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

    // Auto-reconnect (silent)
    this.sse.onerror = () => {
      try {
        this.sse.close();
      } catch {}

      const delay = this._sseRetryMs || 1000;
      this._sseRetryMs = Math.min(delay * 2, 15000);

      clearTimeout(this._sseRetryTimer);
      this._sseRetryTimer = setTimeout(() => {
        try {
          this.connectSse(); // FIX: was startSse()
        } catch {}
      }, delay);
    };

    this.sse.onopen = () => {
      this._sseRetryMs = 1000;
    };

    return es;
  }

  connectWs() {
    if (!this.userId) throw new Error("Cannot connect WS without userId");

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return this.ws;
    }

    const url = `${this.wsUrl}/gateway?userId=${encodeURIComponent(this.userId)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => this.emit("debug", { where: "ws", message: "WS open" });
    ws.onerror = () =>
      this.emit("error", { where: "ws", error: "WebSocket error" });
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

        // Map WS event names to UI events (IMPORTANT: includes lobby_update)
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

        this.emit("debug", { where: "ws", message: "Unmapped WS message", msg });
      } catch (e) {
        this.emit("error", {
          where: "ws",
          error: `WS message parse failed: ${String(e)}`,
        });
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
  // Matchmaking + Match (Etapa II-IV)
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

  /**
   * GET /api/matches/{matchId}/state (snapshot)
   */
  async getMatchState({ matchId }, { timeoutMs = 8000 } = {}) {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/matches/${encodeURIComponent(matchId)}/state`,
      {
        method: "GET",
        headers: {
          ...this.getAuthHeaders(),
        },
      },
      timeoutMs
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Snapshot failed (${res.status}): ${text}`);
    }

    return res.json();
  }

  /**
   * POST /api/matches/{matchId}/moves
   */
  async sendMove({ matchId, from, to }, { timeoutMs = 8000 } = {}) {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/matches/${encodeURIComponent(matchId)}/moves`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.getAuthHeaders(),
        },
        body: JSON.stringify({ from, to }),
      },
      timeoutMs
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Move send failed (${res.status}): ${text}`);
    }

    const t = await res.text().catch(() => "");
    try {
      return t ? JSON.parse(t) : { ok: true };
    } catch {
      return { ok: true };
    }
  }

  /**
   * POST /api/matches/{matchId}/forfeit
   */
  async forfeit({ matchId, reason = "VOLUNTARY" }, { timeoutMs = 8000 } = {}) {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/matches/${encodeURIComponent(matchId)}/forfeit`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.getAuthHeaders(),
        },
        body: JSON.stringify({ reason }),
      },
      timeoutMs
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Forfeit failed (${res.status}): ${text}`);
    }

    const t = await res.text().catch(() => "");
    try {
      return t ? JSON.parse(t) : { ok: true };
    } catch {
      return { ok: true };
    }
  }

  /**
   * POST /api/matches/{matchId}/report-infraction
   */
  async reportInfraction(
    { matchId, reason, move },
    { timeoutMs = 8000 } = {}
  ) {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/matches/${encodeURIComponent(matchId)}/report-infraction`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.getAuthHeaders(),
        },
        body: JSON.stringify({ reason, move }),
      },
      timeoutMs
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Report infraction failed (${res.status}): ${text}`);
    }

    const t = await res.text().catch(() => "");
    try {
      return t ? JSON.parse(t) : { ok: true };
    } catch {
      return { ok: true };
    }
  }

  sendMatchChatViaWs({ matchId, content }) {
    return this.sendWs("send_match_chat", { matchId, content });
  }
}
