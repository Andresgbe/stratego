import { initMatch } from "./gameState.js";
import { listActions } from "./actions.js";
import { StrategoNetwork } from "./stratego-network.js";
import {
  getState,
  subscribe,
  ejecutarAccion,
  avanzarFase,
  setScreen,
  strategoStartBattleFromServer,
  strategoSetNetworkContext,
  strategoClearNetworkContext,
  strategoHydrateFromServerSnapshot,
  strategoApplyOpponentMovedFromServer,
  strategoApplyCombatResultFromServer,
  strategoIsPvPActive,
} from "./gameEngine.js";
import "./etapa2.js";

let currentPlayerId = 1; // demo

function qs(id) {
  return document.getElementById(id);
}

function renderState() {
  const state = getState();
  const dump = qs("stateDump");
  if (dump) dump.textContent = JSON.stringify(state, null, 2);
}

function populateActions() {
  const sel = qs("actionSelect");
  if (!sel) return;

  sel.innerHTML = "";
  listActions().forEach((a) => {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = `${a.nombre} (costo ${a.costo})`;
    sel.appendChild(opt);
  });
}

function bindWarRoomControls() {
  const doBtn = qs("doActionBtn");
  const nextBtn = qs("nextPhaseBtn");

  if (doBtn) {
    doBtn.addEventListener("click", () => {
      const actionId = qs("actionSelect")?.value;
      const targetId = Number(qs("targetSelect")?.value || 0) || null;

      const res = ejecutarAccion({
        playerId: currentPlayerId,
        actionId,
        targetId,
      });

      if (!res.ok) alert(res.reason);
      renderState();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      avanzarFase();
      renderState();
    });
  }
}

function bootDemoIfNeeded() {
  const state = getState();
  if (state.jugadores.length === 0) {
    initMatch({
      players: [
        { nombre: "Jugador 1", rol: "General" },
        { nombre: "Jugador 2", rol: "Diplomático" },
      ],
    });

    // UI empieza en lobby
    setScreen("lobby");
  }
}

window.addEventListener("DOMContentLoaded", () => {
  // --- Boot local / PvE ---
  bootDemoIfNeeded();
  populateActions();
  bindWarRoomControls();

  subscribe(() => renderState());
  renderState();

  // Mount officers search UI (safe even if called multiple times)
  mountOfficersSearch();

  // --- Networking Lobby ---
  (async () => {
    try {
      let session = null;

      // 1) Intentar reutilizar sesión guardada
      const cached = await net.ensureSession();

      if (cached?.reused) {
        session = { userId: net.userId, username: net.username };
      } else {
        // 2) Crear nueva sesión con reintentos (por 409)
        let attempts = 0;

        while (!session && attempts < 3) {
          attempts += 1;

          const username = askUsernameUntilValid();

          try {
            session = await net.createSession(username, { timeoutMs: 8000 });
            net.persistSession(); // guardar para evitar 409 en reload
          } catch (err) {
            const msg = String(err?.message || err);

            // Username ya en uso → pedir otro
            if (msg.includes("Session create failed (409)")) {
              setStatus("Ese nombre ya está en uso. Elige otro.", "error");
              continue;
            }

            // Otros errores se propagan
            throw err;
          }
        }

        if (!session) {
          setStatus(
            "No se pudo crear sesión (reintentos agotados). Estás en modo local.",
            "error"
          );
          return;
        }
      }

      // --- Eventos de red ---
      net.on("lobbyUpdate", (payload) => {
        const users = Array.isArray(payload)
          ? payload
          : (payload?.users || payload?.payload?.users || payload?.data || []);
        renderOfficers(users);
      });

      net.on("challengeReceived", (payload) => handleChallengeReceived(payload));
      net.on("challengeAnswered", (payload) => handleChallengeAnswered(payload));
      net.on("matchStarted", (payload) => handleMatchStarted(payload));

      net.on("opponentMoved", (payload) => {
        const ev = payload?.matchId ? payload : payload?.payload;
        if (!ev) return;
        strategoApplyOpponentMovedFromServer(ev);
      });

      net.on("combatResult", (payload) => {
        const ev = payload?.matchId ? payload : payload?.payload;
        if (!ev) return;
        strategoApplyCombatResultFromServer(ev);
      });

      net.on("illegalMoveDetected", async (payload) => {
        const ev = payload?.matchId ? payload : payload?.payload;
        if (!ev?.matchId) return;

        setStatus(
          "Movimiento inválido detectado por el servidor. Re-sincronizando...",
          "error"
        );
        try {
          const snapshot = await net.fetchMatchState({ matchId: ev.matchId });
          strategoHydrateFromServerSnapshot(snapshot);
        } catch (err) {
          console.error(err);
        }
      });

      net.on("matchCancelled", (payload) => {
        const ev = payload?.matchId ? payload : payload?.payload;
        if (!ev) return;

        setStatus("El rival abandonó la partida.", "error");
        strategoClearNetworkContext();
        showLobby();
      });

      net.on("matchChatMessage", (msg) => {
        // Append in war room chat if exists
        const line = msg?.content ? msg : msg?.payload;
        if (!line) return;

        const warChatMsgs = document.getElementById("war-chat-msgs");
        if (!warChatMsgs) return;

        warChatMsgs.innerHTML += `<div class="msg"><strong>${escapeHtml(
          line?.from?.username || "Rival"
        )}:</strong> ${escapeHtml(line?.content || "")}</div>`;
        warChatMsgs.scrollTop = warChatMsgs.scrollHeight;
      });

      // --- Conectar canales ---
      net.connectSse();
      net.connectWs();

      setStatus(`Conectado como ${session.username}`, "ok");
      window.__strategoResetSession = resetSessionAndReload;
    } catch (err) {
      console.error(err);

      const msg = String(err?.message || err);

      if (msg.includes("Timeout")) {
        setStatus("Servidor no responde (timeout). Estás en modo local.", "error");
      } else if (msg.includes("Session create failed (400)")) {
        setStatus("Nombre inválido. Debe tener entre 3 y 30 caracteres.", "error");
      } else if (msg.includes("Session create failed (409)")) {
        setStatus("Ese nombre ya está en uso. Recarga y elige otro.", "error");
      } else {
        setStatus("No se pudo conectar al servidor. Estás en modo local.", "error");
      }
    }
  })();
});

// ==============================
// Lobby (Etapa I)
// ==============================
const lobby = {
  selectedOfficer: null,
  mode: "classic",
  protocol: "fetch",
  pendingChallengeId: null,
  pendingProtocolMode: null,

  // Search state
  officerQuery: "",
  officersCache: [],
};

// ==============================
// Networking (Etapa I - mínimo viable)
// ==============================
const API_BASE_URL = "https://stratego-api.koyeb.app";

const net = new StrategoNetwork({ baseUrl: API_BASE_URL });

// Expose network for etapa2.js (no frameworks, simplest bridge)
window.__strategoNet = net;

// Allow Etapa II-IV UI to send match commands
window.__strategoNet = net;

// ==============================
// Dev helper: reset session (for testing 2 players)
// ==============================
async function resetSessionAndReload() {
  try {
    // Best-effort: delete server session (optional)
    await fetch(`${API_BASE_URL}/api/sessions/current`, {
      method: "DELETE",
      headers: {
        ...net.getAuthHeaders(),
      },
    });
  } catch {
    // ignore
  }

  localStorage.removeItem("stratego.session");
  location.reload();
}

// UI refs (dynamic)
const officersListEl = document.getElementById("officers-list");
const lobbyChatMessagesEl = document.getElementById("lobby-chat-messages");

// ==============================
// Officers search (UI in Spanish, code in English)
// ==============================
let officersSearchInputEl = null;

function mountOfficersSearch() {
  if (!officersListEl) return;
  if (officersSearchInputEl) return;

  const wrapper = document.createElement("div");
  wrapper.className = "officers-search";

  const label = document.createElement("label");
  label.textContent = "Buscar oficial";
  label.style.display = "block";
  label.style.marginBottom = "6px";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Escribe un nombre…";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.style.width = "100%";
  input.style.padding = "8px";
  input.style.borderRadius = "6px";

  input.addEventListener("input", () => {
    lobby.officerQuery = input.value || "";
    renderOfficers(lobby.officersCache);
  });

  wrapper.appendChild(label);
  wrapper.appendChild(input);

  // Insert search UI just before the <ul id="officers-list">
  officersListEl.parentElement.insertBefore(wrapper, officersListEl);

  officersSearchInputEl = input;
}

// Try mounting immediately too (safe). If DOM isn't ready, it simply won't mount.
mountOfficersSearch();

function askUsernameUntilValid() {
  // Basic UX: prompt is enough for MVP
  // Server rules: 3-30 chars, letters/numbers/spaces/underscore
  // We still let the server be the judge for uniqueness.
  // UI stays Spanish, code English.
  let name = "";
  while (!name) {
    name =
      window
        .prompt("Elige tu nombre de Oficial (3 a 30 caracteres):", "")
        ?.trim() || "";
    if (name.length < 3 || name.length > 30) name = "";
  }
  return name;
}

function renderOfficers(users) {
  if (!officersListEl) return;

  const rawList = Array.isArray(users)
    ? users
    : (users?.users || users?.payload?.users || users?.data || []);

  // Cache the last list received (so the search input can re-render without new network calls)
  lobby.officersCache = rawList;

  const query = String(lobby.officerQuery || "").trim().toLowerCase();

  // 1) Deduplicar por userId
  const seen = new Set();
  let list = [];
  for (const u of rawList) {
    const id = String(u?.userId ?? "");
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    list.push(u);
  }

  // 2) Filtrar usernames basura
  const isValidUsername = (name) => {
    const s = String(name || "").trim();
    if (s.length < 3 || s.length > 30) return false;
    if (!/[a-zA-Z0-9]/.test(s)) return false;
    if (/^_+\d*$/.test(s)) return false;
    return true;
  };

  list = list.filter((u) => isValidUsername(u?.username));

  // 2.5) Apply search filter (by username)
  if (query) {
    list = list.filter((u) =>
      String(u?.username || "").toLowerCase().includes(query)
    );
  }

  // 3) Quitarme a mí mismo
  list = list.filter((u) => String(u.userId) !== String(net.userId));

  // 4) Ordenar: disponibles primero
  list.sort((a, b) => {
    const sa = a?.status === "AVAILABLE" ? 0 : 1;
    const sb = b?.status === "AVAILABLE" ? 0 : 1;
    return sa - sb;
  });

  // 5) Mezclar para no ver siempre los mismos (solo si NO hay búsqueda)
  if (!query) {
    list = list.sort(() => Math.random() - 0.5);
  }

  const MAX = 25;
  const total = list.length;
  const shown = list.slice(0, MAX);

  officersListEl.innerHTML = "";

  if (shown.length === 0) {
    const li = document.createElement("li");
    li.textContent = query
      ? "No hay oficiales que coincidan con la búsqueda."
      : "No hay oficiales conectados.";
    li.classList.add("muted");
    officersListEl.appendChild(li);
    return;
  }

  shown.forEach((u) => {
    const li = document.createElement("li");

    if (
      lobby.selectedOfficer?.userId &&
      String(lobby.selectedOfficer.userId) === String(u.userId)
    ) {
      li.classList.add("is-selected");
    }

    const name = document.createElement("strong");
    name.textContent = u.username;

    const status = document.createElement("span");
    status.className = "officer-status";
    status.textContent = u.status === "IN_GAME" ? "— en partida" : "— disponible";

    const btn = document.createElement("button");
    btn.textContent = "Retar";
    btn.dataset.userId = u.userId;
    btn.dataset.username = u.username;

    btn.disabled = u.status !== "AVAILABLE";

    li.appendChild(name);
    li.appendChild(status);
    li.appendChild(btn);
    officersListEl.appendChild(li);
  });

  if (total > MAX) {
    const li = document.createElement("li");
    li.classList.add("muted");
    li.textContent = `Mostrando ${MAX} de ${total} oficiales. (Hay más conectados)`;
    officersListEl.appendChild(li);
  }
}

function appendLobbyChatLine({ from, content }) {
  if (!lobbyChatMessagesEl) return;

  const p = document.createElement("p");
  const safeUser = escapeHtml(from?.username || "Desconocido");
  const safeText = escapeHtml(content || "");
  p.innerHTML = `<strong>${safeUser}:</strong> ${safeText}`;
  lobbyChatMessagesEl.appendChild(p);
  lobbyChatMessagesEl.scrollTop = lobbyChatMessagesEl.scrollHeight;
}

const statusEl = document.getElementById("challenge-status");
const btnSendChallenge = document.getElementById("btn-send-challenge");
const btnStartPve = document.getElementById("btn-start-pve");

const lobbyScreen = document.getElementById("lobby-screen");
const warRoom = document.getElementById("war-room");
const btnBackLobby = document.getElementById("btn-back-lobby");

function showWarRoom() {
  if (lobbyScreen) lobbyScreen.classList.add("hidden");
  if (warRoom) warRoom.classList.remove("hidden");
  setScreen("warroom");
}

function showLobby() {
  if (warRoom) warRoom.classList.add("hidden");
  if (lobbyScreen) lobbyScreen.classList.remove("hidden");
  setScreen("lobby");
}

if (btnBackLobby) btnBackLobby.addEventListener("click", showLobby);

function setStatus(message, type = "neutral") {
  if (!statusEl) return;
  statusEl.textContent = message;

  statusEl.classList.remove("is-error", "is-ok");
  if (type === "error") statusEl.classList.add("is-error");
  if (type === "ok") statusEl.classList.add("is-ok");
}

function canSendChallenge() {
  return Boolean(lobby.selectedOfficer);
}

// =====================================
// PvP Challenge Flow (real matchmaking)
// =====================================

const challengeCache = {
  incoming: new Map(), // challengeId -> { mode, protocolMode, challenger }
  outgoing: new Map(), // challengeId -> { targetUserId, targetUsername, mode, protocolMode }
};

function pickProtocolModeRandom50() {
  if (typeof net?.pickRandomProtocolMode === "function") {
    return net.pickRandomProtocolMode();
  }
  return Math.random() < 0.5 ? "FETCH_FIRST" : "SOCKET_FIRST";
}

function handleChallengeReceived(payload) {
  const challengeId = payload?.challengeId;
  if (!challengeId) return;

  const challenger = payload?.challenger || {};
  const challengerName = challenger.username || "(desconocido)";
  const mode = payload?.mode || "CLASSIC_WAR";
  const protocolMode = payload?.protocolMode || "FETCH_FIRST";

  challengeCache.incoming.set(challengeId, {
    challengeId,
    mode,
    protocolMode,
    challenger,
  });

  const ok = window.confirm(
    `Reto recibido de ${challengerName}\n\nModo: ${mode}\nProtocolo: ${protocolMode}\n\n¿Aceptar?`
  );

  net
    .answerChallenge({ challengeId, answer: ok ? "ACCEPTED" : "REJECTED" })
    .then(() => {
      setStatus(
        ok ? "Reto aceptado. Preparando partida..." : "Reto rechazado.",
        ok ? "ok" : "neutral"
      );
    })
    .catch((err) => {
      console.error(err);
      setStatus("No se pudo responder el reto.", "error");
    });
}

function handleChallengeAnswered(payload) {
  const challengeId = payload?.challengeId;
  const answer = payload?.answer;

  if (!challengeId || !answer) return;

  if (answer === "REJECTED") {
    setStatus("El reto fue rechazado.", "neutral");
    challengeCache.outgoing.delete(challengeId);
    challengeCache.incoming.delete(challengeId);
    return;
  }

  const matchId = payload?.matchId;
  if (!matchId) {
    setStatus("Reto aceptado, pero no llegó matchId.", "error");
    return;
  }

  const challenger = payload?.challenger || {};
  const challenged = payload?.challenged || {};

  const ctx =
    challengeCache.outgoing.get(challengeId) ||
    challengeCache.incoming.get(challengeId) ||
    {};

  const mode = payload?.mode || ctx.mode || "CLASSIC_WAR";
  const protocolMode =
    payload?.protocolMode || ctx.protocolMode || "FETCH_FIRST";

  const isChallenger = String(net.userId) === String(challenger.userId);
  const localPlayerId = isChallenger ? 1 : 2;
  const team = isChallenger ? "RED" : "BLUE";
  const opponent = isChallenger ? challenged : challenger;

  // IMPORTANT: align local controls with correct player id
  currentPlayerId = localPlayerId;

  window.__strategoMatch = {
    matchId,
    mode,
    protocolMode,
    team,
    localPlayerId,
    challenger,
    challenged,
    opponent,
  };

  initMatch({
    players: [
      { nombre: challenger.username || "Jugador 1", rol: "General" },
      { nombre: challenged.username || "Jugador 2", rol: "General" },
    ],
  });

  setStatus(`Partida creada: ${matchId}. Entra al Cuarto de Guerra.`, "ok");
  showWarRoom();

  challengeCache.outgoing.delete(challengeId);
  challengeCache.incoming.delete(challengeId);
}

function handleMatchStarted(payload) {
  const matchId = payload?.matchId;
  if (!matchId) return;

  // ignore unrelated matches
  if (
    window.__strategoMatch?.matchId &&
    window.__strategoMatch.matchId !== matchId
  )
    return;

  setStatus("¡Batalla iniciada!", "ok");
  strategoStartBattleFromServer({ turnOwnerId: 1 }); // RED = playerId 1
}

// Dynamic officers list: click -> select target (supports initial HTML + dynamic render)
if (officersListEl) {
  officersListEl.addEventListener("click", (e) => {
    const btn = e.target.closest('button[data-user-id], button[data-userid]');
    if (!btn || btn.disabled) return;

    const li = btn.closest("li");

    // Clear previous selection highlight
    officersListEl
      .querySelectorAll("li")
      .forEach((x) => x.classList.remove("is-selected"));

    // Read target from datasets
    const userId = btn.dataset.userId || btn.dataset.userid || null;
    const username = btn.dataset.username || "Desconocido";

    // Save selection
    lobby.selectedOfficer = { userId, username };

    // Highlight selected row
    if (li) li.classList.add("is-selected");

    setStatus(`Objetivo seleccionado: ${username}`, "ok");
  });
}

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    lobby.mode = radio.value;
    setStatus(
      `Modalidad: ${lobby.mode === "classic" ? "Guerra Clásica" : "Duelo Rápido"}`
    );
  });
});

document.querySelectorAll('input[name="protocol"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    lobby.protocol = radio.value;
    setStatus(
      `Protocolo: ${lobby.protocol === "fetch" ? "Fetch + SSE" : "WebSockets"}`
    );
  });
});

if (btnSendChallenge) {
  btnSendChallenge.addEventListener("click", async () => {
    if (!canSendChallenge()) {
      setStatus("Falta seleccionar un oficial antes de retar.", "error");
      return;
    }

    const targetUserId = lobby.selectedOfficer.userId;
    const targetUsername = lobby.selectedOfficer.username;

    const mode = lobby.mode === "classic" ? "CLASSIC_WAR" : "QUICK_DUEL";

    // REQUIRED: 50/50 random, ignore UI protocol radio
    const protocolMode = pickProtocolModeRandom50();

    try {
      btnSendChallenge.disabled = true;
      setStatus(`Enviando reto a ${targetUsername}...`, "ok");

      const res = await net.createChallenge({ targetUserId, mode, protocolMode });

      challengeCache.outgoing.set(res.challengeId, {
        challengeId: res.challengeId,
        targetUserId,
        targetUsername,
        mode,
        protocolMode,
      });

      setStatus(
        `Reto enviado a ${targetUsername}. Esperando respuesta... (${mode}, ${protocolMode})`,
        "ok"
      );
    } catch (err) {
      console.error(err);
      setStatus("No se pudo enviar el reto.", "error");
    } finally {
      btnSendChallenge.disabled = false;
    }
  });
}

if (btnStartPve) {
  btnStartPve.addEventListener("click", () => {
    setStatus(`Iniciando PvE en modo ${lobby.mode}...`, "ok");
    showWarRoom();
  });
}

const chatForm = document.getElementById("chat-form");
if (chatForm) {
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const input = document.getElementById("chat-message");
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    const ok = net.sendLobbyChat(text);
    if (!ok) {
      appendLobbyChatLine({
        from: { username: "Tú" },
        content: `${text} (sin conexión)`,
      });
    } else {
      appendLobbyChatLine({ from: { username: "Tú" }, content: text });
    }

    input.value = "";
  });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

setStatus("Selecciona un oficial y configura el reto.");
