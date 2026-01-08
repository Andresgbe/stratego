import {
  STRATEGO_ARMY_CONFIG,
} from "./gameState.js";
import {
  getState,
  subscribe,
  strategoPlaceFromInventory,
  strategoMoveOrSwapDeployment,
  strategoRandomizeDeployment,
  strategoClearDeployment,
  strategoExportDeployment,
  strategoImportDeployment,
  strategoSetReady,
  strategoSelectCell,
  strategoMove,
} from "./gameEngine.js";

// ===============================
// Config / helpers
// ===============================
const LOCAL_PLAYER_ID = 1; // demo (luego lo conectas a login/rol)

function isWater(r, c) {
  return (r === 4 || r === 5) && ((c === 2 || c === 3) || (c === 6 || c === 7));
}

function isLocalDeployZone(r) {
  // Para el jugador local (P1): filas 0..3
  return r >= 0 && r <= 3;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function rankToDef(rank) {
  return STRATEGO_ARMY_CONFIG.find((x) => x.rank === rank) || null;
}

function canInteractDeployment(state) {
  // Regla Etapa III: Drag&Drop solo permitido durante DEPLOYMENT
  return state?.fase === "planificacion" && state?.stratego?.phase === "DEPLOYMENT";
}

// ===============================
// DOM refs
// ===============================
const boardEl = document.getElementById("game-board");
const piecesContainer = document.getElementById("pieces-container");

const btnRandom = document.getElementById("btn-randomize");
const btnClear = document.getElementById("btn-clear-board");
const btnReady = document.getElementById("btn-ready-war");
const btnSave = document.getElementById("btn-save-strat");
const btnLoad = document.getElementById("btn-load-strat");
const overlay = document.getElementById("waiting-overlay");

const warChatForm = document.getElementById("war-chat-form");
const warChatMsgs = document.getElementById("war-chat-msgs");
const warChatInput = document.getElementById("war-chat-input");

// ===============================
// Board: construir grid 10x10 UNA vez
// ===============================
let _boardBuilt = false;
let _dragSource = null; // { source: 'inventory'|'board', rank, fromCellId? }

function ensureBoardGrid() {
  if (!boardEl || _boardBuilt) return;
  boardEl.innerHTML = "";

  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = document.createElement("div");
      cell.classList.add("cell");
      cell.dataset.row = String(r);
      cell.dataset.col = String(c);
      cell.id = `cell-${r}-${c}`;

      if (isWater(r, c)) {
        cell.classList.add("water");
      } else if (isLocalDeployZone(r)) {
        cell.classList.add("deploy-zone");
      }

      // Listeners (solo una vez). Validación real la hace el engine.
      cell.addEventListener("dragover", (e) => {
        const state = getState();
        if (!canInteractDeployment(state)) return;
        // solo permitir dropear si el target es válido (mejor UX)
        if (isWater(r, c) || !isLocalDeployZone(r)) return;

        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        cell.classList.add("drag-over");
      });

      cell.addEventListener("dragleave", () => {
        cell.classList.remove("drag-over");
      });

      cell.addEventListener("drop", (e) => {
        e.preventDefault();
        cell.classList.remove("drag-over");

      // =========================
      // Etapa IV: Click-to-move en BATTLE
      // =========================
      cell.addEventListener("click", () => {
        const state = getState();
        if (state?.stratego?.phase !== "BATTLE") return;

        // solo el jugador con turno puede interactuar
        if (state?.stratego?.turnOwnerId !== LOCAL_PLAYER_ID) return;

        const clickedCellId = cell.id;
        const board = state?.stratego?.board || {};
        const piece = board[clickedCellId];
        const selected = state?.stratego?.ui?.selectedCell;

        // Si clickeo mi propia pieza móvil => seleccionar
        if (piece && piece.ownerId === LOCAL_PLAYER_ID) {
          const res = strategoSelectCell(LOCAL_PLAYER_ID, clickedCellId);
          if (!res.ok) alert(res.reason);
          return;
        }

        // Si ya tengo selección => intento mover/atacar
        if (selected) {
          const res = strategoMove({
            playerId: LOCAL_PLAYER_ID,
            fromCellId: selected,
            toCellId: clickedCellId,
          });
          if (!res.ok) alert(res.reason);
        }
      });

        const state = getState();
        if (!canInteractDeployment(state)) return;
        if (isWater(r, c) || !isLocalDeployZone(r)) return;

        let payload;
        try {
          payload = JSON.parse(e.dataTransfer.getData("text/plain"));
        } catch {
          return;
        }
        if (!payload) return;

        const targetCellId = cell.id;

        // Inventario -> Tablero
        if (payload.source === "inventory") {
          const res = strategoPlaceFromInventory({
            playerId: LOCAL_PLAYER_ID,
            rank: payload.rank,
            targetCellId,
          });
          if (!res.ok) alert(res.reason);
          return;
        }

        // Tablero -> Tablero
        if (payload.source === "board") {
          const res = strategoMoveOrSwapDeployment({
            playerId: LOCAL_PLAYER_ID,
            fromCellId: payload.fromCellId,
            toCellId: targetCellId,
          });
          if (!res.ok) alert(res.reason);
        }
      });

      boardEl.appendChild(cell);
    }
  }

  _boardBuilt = true;
}

// ===============================
// Render: board + inventario desde gameState
// ===============================
function createPieceElement({ rank, label, draggable, dragPayload }) {
  const div = document.createElement("div");
  div.classList.add("piece");
  div.textContent = label;
  div.dataset.rank = rank;
  div.draggable = Boolean(draggable);

  if (div.draggable) {
    div.addEventListener("dragstart", (e) => {
      const state = getState();
      if (!canInteractDeployment(state)) {
        e.preventDefault();
        return;
      }

      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", JSON.stringify(dragPayload));
      _dragSource = dragPayload;
      setTimeout(() => (div.style.opacity = "0.5"), 0);
    });

    div.addEventListener("dragend", () => {
      div.style.opacity = "1";
      _dragSource = null;
      document.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
    });
  }

  return div;
}

function renderBoard(state) {
  if (!boardEl) return;
  ensureBoardGrid();

  // Limpiar piezas renderizadas + clases visuales dinámicas
  for (const cell of boardEl.querySelectorAll(".cell")) {
    cell.innerHTML = "";
    cell.classList.remove("selected");
  }

  const phase = state?.stratego?.phase;
  const board = state?.stratego?.board || {};

  for (const [cid, piece] of Object.entries(board)) {
    const cell = document.getElementById(cid);
    if (!cell) continue;

    const def = rankToDef(piece.rank);

    // En despliegue: solo renderizamos al jugador local
    if (phase === "DEPLOYMENT") {
      if (piece.ownerId !== LOCAL_PLAYER_ID) continue;
      const label = def?.label ?? piece.rank;

      const el = createPieceElement({
        rank: piece.rank,
        label,
        draggable: true,
        dragPayload: { source: "board", fromCellId: cid, rank: piece.rank },
      });

      cell.appendChild(el);
      continue;
    }

    // Fuera de despliegue (HANDSHAKE/BATTLE/GAME_OVER): enemigo oculto
    if (piece.ownerId === LOCAL_PLAYER_ID) {
      const label = def?.label ?? piece.rank;
      const el = createPieceElement({
        rank: piece.rank,
        label,
        draggable: false,
        dragPayload: null,
      });
      cell.appendChild(el);
    } else {
      const hidden = createPieceElement({
        rank: piece.rank,
        label: "❓",
        draggable: false,
        dragPayload: null,
      });
      cell.appendChild(hidden);
    }
  }

  // Etapa IV: resaltar selección (click-to-move)
  const selected = state?.stratego?.ui?.selectedCell;
  if (selected) {
    const el = document.getElementById(selected);
    if (el) el.classList.add("selected");
  }
}

function renderInventory(state) {
  if (!piecesContainer) return;

  piecesContainer.innerHTML = "";

  const inv = state?.stratego?.inventory?.[LOCAL_PLAYER_ID] || {};
  const interactive = canInteractDeployment(state);

  for (const def of STRATEGO_ARMY_CONFIG) {
    const count = Number(inv[def.rank] || 0);
    if (count <= 0) continue;

    const group = document.createElement("div");
    group.style.display = "flex";
    group.style.flexDirection = "column";
    group.style.alignItems = "center";

    const pieceEl = createPieceElement({
      rank: def.rank,
      label: def.label,
      draggable: interactive,
      dragPayload: { source: "inventory", rank: def.rank },
    });

    const countBadge = document.createElement("span");
    countBadge.textContent = `x${count}`;
    countBadge.style.fontSize = "10px";
    countBadge.style.color = "#aaa";

    group.appendChild(pieceEl);
    group.appendChild(countBadge);
    piecesContainer.appendChild(group);
  }
}

function renderOverlay(state) {
  if (!overlay) return;
  const phase = state?.stratego?.phase;

  if (phase === "HANDSHAKE") overlay.classList.remove("hidden");
  else overlay.classList.add("hidden");
}

function renderAll(state) {
  if (!boardEl) return;
  renderOverlay(state);
  renderBoard(state);
  renderInventory(state);
}

// ===============================
// Botones
// ===============================
if (btnRandom) {
  btnRandom.addEventListener("click", () => {
    const res = strategoRandomizeDeployment(LOCAL_PLAYER_ID);
    if (!res.ok) alert(res.reason);
  });
}

if (btnClear) {
  btnClear.addEventListener("click", () => {
    strategoClearDeployment(LOCAL_PLAYER_ID);
  });
}

if (btnSave) {
  btnSave.addEventListener("click", () => {
    const data = strategoExportDeployment(LOCAL_PLAYER_ID);
    localStorage.setItem("stratego_setup", JSON.stringify(data));
    alert("📜 Grimorio guardado en el archivo local.");
  });
}

if (btnLoad) {
  btnLoad.addEventListener("click", () => {
    const raw = localStorage.getItem("stratego_setup");
    if (!raw) {
      alert("No tienes estrategias guardadas.");
      return;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      alert("El grimorio guardado está corrupto.");
      return;
    }

    // Backwards compat: si estaba guardado con {rank,label}
    const normalized = {};
    for (const [cid, obj] of Object.entries(data || {})) {
      if (!obj) continue;
      const rank = obj.rank;
      if (rank) normalized[cid] = { rank };
    }

    const res = strategoImportDeployment(LOCAL_PLAYER_ID, normalized);
    if (!res.ok) alert(res.reason);
  });
}

if (btnReady) {
  btnReady.addEventListener("click", () => {
    const res = strategoSetReady(LOCAL_PLAYER_ID, { autoEnemy: true });
    if (!res.ok) alert(res.reason);
  });
}

// ===============================
// Chat (simulado)
// ===============================
if (warChatForm && warChatMsgs && warChatInput) {
  warChatForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const text = warChatInput.value.trim();
    if (!text) return;

    warChatMsgs.innerHTML += `<div class="msg" style="color: #4caf50;"><strong>Tú:</strong> ${escapeHtml(text)}</div>`;
    warChatInput.value = "";
    warChatMsgs.scrollTop = warChatMsgs.scrollHeight;
  });
}

// ===============================
// Boot
// ===============================
if (boardEl) {
  ensureBoardGrid();
  subscribe((state) => renderAll(state));
  renderAll(getState());
}
