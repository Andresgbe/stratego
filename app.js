import { initMatch } from "./gameState.js";
import { listActions } from "./actions.js";
import {
  getState,
  subscribe,
  ejecutarAccion,
  avanzarFase,
  setScreen,
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
  bootDemoIfNeeded();
  populateActions();
  bindWarRoomControls();

  subscribe(() => renderState());
  renderState();
});

// ==============================
// Lobby (Etapa I)
// ==============================
const lobby = {
  selectedOfficer: null,
  mode: "classic",
  protocol: "fetch",
};

const statusEl = document.getElementById("challenge-status");
const officersListItems = Array.from(document.querySelectorAll("#lobby-officers li"));
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

function clearOfficerSelectionUI() {
  officersListItems.forEach((li) => li.classList.remove("is-selected"));
}

function selectOfficerUI(officerName) {
  clearOfficerSelectionUI();
  const btn = document.querySelector(`button[data-officer="${officerName}"]`);
  if (!btn) return;
  const li = btn.closest("li");
  if (li) li.classList.add("is-selected");
}

function canSendChallenge() {
  return Boolean(lobby.selectedOfficer);
}

document.querySelectorAll("button[data-officer]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;

    lobby.selectedOfficer = btn.dataset.officer;
    selectOfficerUI(lobby.selectedOfficer);
    setStatus(`Objetivo seleccionado: ${lobby.selectedOfficer}`, "ok");
  });
});

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
      to: lobby.selectedOfficer,
      mode: lobby.mode,
      protocol: lobby.protocol,
    };

    setStatus(`Reto enviado a ${payload.to} (${payload.mode}, ${payload.protocol})`, "ok");
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

    const chatBox = document.querySelector("#lobby-chat div");
    if (!chatBox) return;

    const p = document.createElement("p");
    p.innerHTML = `<strong>Tú:</strong> ${escapeHtml(text)}`;
    chatBox.appendChild(p);

    chatBox.scrollTop = chatBox.scrollHeight;
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
