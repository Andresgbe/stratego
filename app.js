import { initMatch } from "./gameState.js";
import { listActions } from "./actions.js";
import { StrategoNetwork } from "./stratego-network.js";
import {
  getState,
  subscribe,
  ejecutarAccion,
  avanzarFase,
  setScreen,
  strategoSetNetworkContext,
  strategoClearNetworkContext,
  strategoHydrateFromServerSnapshot,
  strategoApplyRemoteMove,
  strategoApplyCombatResult,
  strategoSetGameOverFromServer,
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

      net.on("lobbyChat", (msg) => appendLobbyChatLine(msg));

      // --- Conectar canales ---
      net.connectSse();
      net.connectWs();

      setStatus(`Conectado como ${session.username}`, "ok");
    } catch (err) {
      console.error(err);

      const msg = String(err?.message || err);

      if (msg.includes("Timeout")) {
        setStatus(
          "Servidor no responde (timeout). Estás en modo local.",
          "error"
        );
      } else if (msg.includes("Session create failed (400)")) {
        setStatus(
          "Nombre inválido. Debe tener entre 3 y 30 caracteres.",
          "error"
        );
      } else if (msg.includes("Session create failed (409)")) {
        setStatus(
          "Ese nombre ya está en uso. Recarga y elige otro.",
          "error"
        );
      } else {
        setStatus(
          "No se pudo conectar al servidor. Estás en modo local.",
          "error"
        );
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
};

// ==============================
// Networking (Etapa I - mínimo viable)
// ==============================
const API_BASE_URL = "https://stratego-api.koyeb.app";

const net = new StrategoNetwork({ baseUrl: API_BASE_URL });

// Expose minimal hooks for other modules (etapa2.js)
window.__strategoNetwork = net;

// Match context for PvP (filled when a real match is accepted)
window.__strategoMatch = null;

// ==============================
// PvP helpers – build setup payload
// ==============================

function mapEngineRankToApi(rank) {
  const r = String(rank);
  const map = {
    "10": { type: "MARSHAL", rank: 1 },
    "9": { type: "GENERAL", rank: 2 },
    "8": { type: "COLONEL", rank: 3 },
    "4": { type: "SERGEANT", rank: 7 },
    "2": { type: "SCOUT", rank: 9 },
    S: { type: "SPY", rank: 10 },
    B: { type: "BOMB", rank: 11 },
    F: { type: "FLAG", rank: 0 },
  };
  return map[r] || null;
}

function cellIdToPosition(cellId) {
  const m = /^cell-(\d+)-(\d+)$/.exec(String(cellId));
  if (!m) return null;
  return { x: Number(m[2]), y: Number(m[1]) };
}

/**
 * Used by etapa2.js when user presses READY in PvP
 */
window.__strategoBuildSetupPayload = function () {
  const state = getState();
  const board = state?.stratego?.board || {};

  const match = window.__strategoMatch;
  if (!match) return [];

  const { team, localPlayerId } = match;
  if (!team || !localPlayerId) return [];

  const pieces = [];

  for (const [cellId, piece] of Object.entries(board)) {
    if (!piece || piece.ownerId !== localPlayerId) continue;

    const def = mapEngineRankToApi(piece.rank);
    const pos = cellIdToPosition(cellId);
    if (!def || !pos) continue;

    pieces.push({
      type: def.type,
      rank: def.rank,
      team,
      position: pos,
      isRevealed: false,
    });
  }

  return pieces;
};

// UI refs (dynamic)
const officersListEl = document.getElementById("officers-list");
const lobbyChatMessagesEl = document.getElementById("lobby-chat-messages");

function askUsernameUntilValid() {
  // Basic UX: prompt is enough for MVP
  // Server rules: 3-30 chars, letters/numbers/spaces/underscore
  // We still let the server be the judge for uniqueness.
  // UI stays Spanish, code English.
  let name = "";
  while (!name) {
    name = window.prompt("Elige tu nombre de Oficial (3 a 30 caracteres):", "")?.trim() || "";
    if (name.length < 3 || name.length > 30) name = "";
  }
  return name;
}

function renderOfficers(users) {
  if (!officersListEl) return;

  const rawList = Array.isArray(users)
    ? users
    : (users?.users || users?.payload?.users || users?.data || []);

  // --- 1) Deduplicar por userId ---
  const seen = new Set();
  let list = [];
  for (const u of rawList) {
    const id = String(u?.userId ?? "");
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    list.push(u);
  }

  // --- 2) Filtrar usernames basura (muy típico en pruebas) ---
  const isValidUsername = (name) => {
    const s = String(name || "").trim();
    if (s.length < 3 || s.length > 30) return false;

    // Evita nombres tipo "_____" o "-----" o mezclas sin letras/números
    const hasAlphaNum = /[a-zA-Z0-9]/.test(s);
    if (!hasAlphaNum) return false;

    // Evita nombres con solo "_" y números, tipo "__123"
    const onlyUnderscoreDigits = /^_+\d*$/.test(s);
    if (onlyUnderscoreDigits) return false;

    return true;
  };

  list = list.filter((u) => isValidUsername(u?.username));

  // --- 3) Ordenar: disponibles arriba (opcional, se siente mejor) ---
  list.sort((a, b) => {
    const sa = a?.status === "AVAILABLE" ? 0 : 1;
    const sb = b?.status === "AVAILABLE" ? 0 : 1;
    return sa - sb;
  });

  // --- 4) Limitar cantidad (MVP UI) ---
  const MAX = 25;
  const total = list.length;
  const shown = list.slice(0, MAX);

  officersListEl.innerHTML = "";

  if (shown.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No hay oficiales conectados.";
    li.classList.add("muted");
    officersListEl.appendChild(li);
    return;
  }

  shown.forEach((u) => {
    const li = document.createElement("li");

    // Mantener highlight si ya estaba seleccionado
    if (
      lobby.selectedOfficer?.userId &&
      String(lobby.selectedOfficer.userId) === String(u.userId)
    ) {
      li.classList.add("is-selected");
    }

    const name = document.createElement("strong");
    name.textContent = u.username || "Oficial desconocido";

    const status = document.createElement("span");
    status.className = "officer-status";
    status.textContent = u.status === "IN_GAME" ? "— en partida" : "— disponible";

    const btn = document.createElement("button");
    btn.textContent = "Retar";
    btn.dataset.userId = u.userId;
    btn.dataset.username = u.username;

  const usernameOk = typeof u.username === "string" && u.username.trim().length >= 3 && u.username.trim().length <= 30;
  const disabled =
    u.userId === net.userId ||
    u.status !== "AVAILABLE" ||
    !usernameOk;

  btn.disabled = disabled;

    li.appendChild(name);
    li.appendChild(status);
    li.appendChild(btn);
    officersListEl.appendChild(li);
  });

  // Pie informativo si hay más de los que mostramos
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

// Dynamic officers list: click -> select target (supports initial HTML + dynamic render)
if (officersListEl) {
  officersListEl.addEventListener("click", (e) => {
    // Support both:
    // - dynamic render: data-user-id + data-username
    // - initial HTML mock: data-officer
    const btn = e.target.closest(
      'button[data-user-id], button[data-userid], button[data-officer]'
    );
    if (!btn || btn.disabled) return;

    const li = btn.closest("li");

    // Clear previous selection highlight
    officersListEl
      .querySelectorAll("li")
      .forEach((x) => x.classList.remove("is-selected"));

    // Read target from datasets
    const userId =
      btn.dataset.userId || btn.dataset.userid || null;

    const username =
      btn.dataset.username || btn.dataset.officer || "Desconocido";

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
    setStatus(`Modalidad: ${lobby.mode === "classic" ? "Guerra Clásica" : "Duelo Rápido"}`);
  });
});

document.querySelectorAll('input[name="protocol"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    lobby.protocol = radio.value;
    setStatus(`Protocolo: ${lobby.protocol === "fetch" ? "Fetch + SSE" : "WebSockets"}`);
  });
});

if (btnSendChallenge) {
  btnSendChallenge.addEventListener("click", () => {
    if (!canSendChallenge()) {
      setStatus("Falta seleccionar un oficial antes de retar.", "error");
      return;
    }

    const payload = {
      targetUserId: lobby.selectedOfficer.userId,
      targetUsername: lobby.selectedOfficer.username,
      mode: lobby.mode === "classic" ? "CLASSIC_WAR" : "QUICK_DUEL",
      protocolMode: lobby.protocol === "fetch" ? "FETCH_FIRST" : "SOCKET_FIRST",
    };

    setStatus(
      `Reto preparado para ${payload.targetUsername} (${payload.mode}, ${payload.protocolMode})`,
      "ok"
    );
    console.log("Enviar reto:", payload);

    showWarRoom();
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
      appendLobbyChatLine({ from: { username: "Tú" }, content: `${text} (sin conexión)` });
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
