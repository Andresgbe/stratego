import { initMatch } from "./gameState.js";
import { listActions } from "./actions.js";
import { getState, ejecutarAccion, avanzarFase } from "./gameEngine.js";
import "./etapa2.js";

let currentPlayerId = 1; // demo: jugador activo (luego lo conectas al login/rol real)

function qs(id) {
  return document.getElementById(id);
}

function renderState() {
  const state = getState();
  const dump = qs("stateDump");
  if (dump) dump.textContent = JSON.stringify(state, null, 2);

  // si quieres, aquí renderizas UI bonita con state.jugadores, fase, etc.
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
      const targetId = Number(qs("targetSelect")?.value || 0) || null; // opcional

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

// DEMO de inicio de partida (en tu proyecto real: esto lo disparas desde Lobby)
function bootDemoIfNeeded() {
  const state = getState();
  if (state.jugadores.length === 0) {
    initMatch({
      players: [
        { nombre: "Jugador 1", rol: "General" },
        { nombre: "Jugador 2", rol: "Diplomático" },
      ],
    });
  }
}

window.addEventListener("DOMContentLoaded", () => {
  bootDemoIfNeeded();
  populateActions();
  bindWarRoomControls();
  renderState();
});

// Estado mínimo del lobby
const lobby = {
  selectedOfficer: null,
  mode: "classic",     // classic | quick
  protocol: "fetch"    // fetch | socket
};

// Helpers UI
const statusEl = document.getElementById("challenge-status");
const officersListItems = Array.from(document.querySelectorAll("#lobby-officers li"));
const btnSendChallenge = document.getElementById("btn-send-challenge");
const btnStartPve = document.getElementById("btn-start-pve");

// Navegación SPA
const lobbyScreen = document.getElementById("lobby-screen");
const warRoom = document.getElementById("war-room");
const btnBackLobby = document.getElementById("btn-back-lobby");

function showWarRoom() {
  if (lobbyScreen) lobbyScreen.classList.add("hidden");
  if (warRoom) warRoom.classList.remove("hidden");
}

function showLobby() {
  if (warRoom) warRoom.classList.add("hidden");
  if (lobbyScreen) lobbyScreen.classList.remove("hidden");
}

if (btnBackLobby) {
  btnBackLobby.addEventListener("click", showLobby);
}

function setStatus(message, type = "neutral") {
  if (!statusEl) return;

  statusEl.textContent = message;

  statusEl.classList.remove("is-error", "is-ok");
  if (type === "error") statusEl.classList.add("is-error");
  if (type === "ok") statusEl.classList.add("is-ok");
}

function clearOfficerSelectionUI() {
  officersListItems.forEach(li => li.classList.remove("is-selected"));
}

function selectOfficerUI(officerName) {
  clearOfficerSelectionUI();

  // marca el <li> que contiene el botón con data-officer = officerName
  const btn = document.querySelector(`button[data-officer="${officerName}"]`);
  if (!btn) return;

  const li = btn.closest("li");
  if (li) li.classList.add("is-selected");
}

function canSendChallenge() {
  return Boolean(lobby.selectedOfficer);
}


// 1) Seleccionar oficial al darle "Retar"
document.querySelectorAll("button[data-officer]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;

    lobby.selectedOfficer = btn.dataset.officer;

    selectOfficerUI(lobby.selectedOfficer);
    setStatus(`Objetivo seleccionado: ${lobby.selectedOfficer}`, "ok");

    console.log("Oficial seleccionado:", lobby.selectedOfficer);
  });
});

// 2) Detectar cambio de modalidad
document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    lobby.mode = radio.value; // classic o quick
    setStatus(`Modalidad: ${lobby.mode === "classic" ? "Guerra Clásica" : "Duelo Rápido"}`);
    console.log("Modalidad:", lobby.mode);
  });
});

// 3) Detectar cambio de protocolo
document.querySelectorAll('input[name="protocol"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    lobby.protocol = radio.value; // fetch o socket
    setStatus(`Protocolo: ${lobby.protocol === "fetch" ? "Fetch + SSE" : "WebSockets"}`);
    console.log("Protocolo principal:", lobby.protocol);
  });
});

// 4) Botón Enviar reto
btnSendChallenge.addEventListener("click", () => {
  if (!canSendChallenge()) {
    setStatus("Falta seleccionar un oficial antes de retar.", "error");
    console.log("Falta seleccionar un oficial antes de retar.");
    return;
  }

  const payload = {
    to: lobby.selectedOfficer,
    mode: lobby.mode,
    protocol: lobby.protocol
  };

  setStatus(`Reto enviado a ${payload.to} (${payload.mode}, ${payload.protocol})`, "ok");
  console.log("Enviar reto:", payload);

  // Pasar a Etapa II (Cuarto de Guerra)
  showWarRoom();
});

// 5) Botón PvE
btnStartPve.addEventListener("click", () => {
  const payload = { mode: lobby.mode };
  setStatus(`Iniciando PvE en modo ${payload.mode}...`, "ok");
  console.log("Iniciar PvE:", payload);

  // Pasar a Etapa II (Cuarto de Guerra)
  showWarRoom();
});

// 6) Chat: evitar recarga y loguear mensaje (+ render en UI)
document.getElementById("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();

  const input = document.getElementById("chat-message");
  const text = input.value.trim();
  if (!text) return;

  console.log("Chat (tú):", text);

  // Render rápido en el chat (sin backend todavía)
  const chatBox = document.querySelector("#lobby-chat div");
  const p = document.createElement("p");
  p.innerHTML = `<strong>Tú:</strong> ${escapeHtml(text)}`;
  chatBox.appendChild(p);

  // autoscroll
  chatBox.scrollTop = chatBox.scrollHeight;

  input.value = "";
});

function escapeHtml(str) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Mensaje inicial
setStatus("Selecciona un oficial y configura el reto.");
