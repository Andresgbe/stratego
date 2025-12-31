// etapa2.js

const ARMY_CONFIG = [
  { rank: "B", label: "💣", count: 6, name: "Bomba" },
  { rank: "10", label: "👮", count: 1, name: "Mariscal" },
  { rank: "9", label: "🎖️", count: 1, name: "General" },
  { rank: "8", label: "🔫", count: 2, name: "Coronel" },
  { rank: "S", label: "🕵️", count: 1, name: "Espía" },
  { rank: "F", label: "🚩", count: 1, name: "Bandera" },
  { rank: "4", label: "💂", count: 3, name: "Sargento" }, // Reducido para ejemplo rápido
  { rank: "2", label: "🏃", count: 4, name: "Explorador" } // Reducido para ejemplo rápido
];

// Referencias DOM (War Room)
const boardEl = document.getElementById("game-board");
const piecesContainer = document.getElementById("pieces-container");
const btnRandom = document.getElementById("btn-randomize");
const btnClear = document.getElementById("btn-clear-board");
const btnReady = document.getElementById("btn-ready-war");
const btnSave = document.getElementById("btn-save-strat");
const btnLoad = document.getElementById("btn-load-strat");
const overlay = document.getElementById("waiting-overlay");

// Chat war-room (IDs distintos al lobby)
const warChatForm = document.getElementById("war-chat-form");
const warChatMsgs = document.getElementById("war-chat-msgs");
const warChatInput = document.getElementById("war-chat-input");

// Estado del juego
let placedPieces = {}; // { "cell-0-1": {rank: 'B', label: '...'}, ... }
let inventoryState = JSON.parse(JSON.stringify(ARMY_CONFIG)); // Copia profunda
let draggedSource = null; // Origen del arrastre

// ==========================================
// 1. INICIALIZACIÓN DEL TABLERO
// ==========================================
function initBoard() {
  if (!boardEl) return;

  boardEl.innerHTML = "";

  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = document.createElement("div");
      cell.classList.add("cell");
      cell.dataset.row = r;
      cell.dataset.col = c;
      cell.id = `cell-${r}-${c}`;

      // Lógica de Terreno
      if (isWater(r, c)) {
        cell.classList.add("water");
      } else if (r <= 3) {
        cell.classList.add("deploy-zone"); // Zona válida para el jugador
        enableDropZone(cell);
      }

      boardEl.appendChild(cell);
    }
  }

  renderInventory();
}

function isWater(r, c) {
  // Lagos en Stratego: Filas 4 y 5, Columnas 2,3 y 6,7
  return (r === 4 || r === 5) && ((c === 2 || c === 3) || (c === 6 || c === 7));
}

// ==========================================
// 2. GESTIÓN DEL INVENTARIO
// ==========================================
function renderInventory() {
  if (!piecesContainer) return;

  piecesContainer.innerHTML = "";

  inventoryState.forEach((item, index) => {
    if (item.count > 0) {
      // Crear contenedor de grupo (para mostrar cantidad)
      const group = document.createElement("div");
      group.style.display = "flex";
      group.style.flexDirection = "column";
      group.style.alignItems = "center";

      // La pieza
      const piece = createPieceElement(item.rank, item.label);
      piece.dataset.inventoryIndex = String(index); // Para saber qué restar

      // Contador
      const countBadge = document.createElement("span");
      countBadge.textContent = `x${item.count}`;
      countBadge.style.fontSize = "10px";
      countBadge.style.color = "#aaa";

      group.appendChild(piece);
      group.appendChild(countBadge);
      piecesContainer.appendChild(group);
    }
  });
}

function createPieceElement(rank, label) {
  const div = document.createElement("div");
  div.classList.add("piece");
  div.textContent = label;
  div.dataset.rank = rank;
  div.draggable = true;

  // Eventos Drag (Pieza)
  div.addEventListener("dragstart", handleDragStart);
  div.addEventListener("dragend", handleDragEnd);

  return div;
}

// ==========================================
// 3. LÓGICA DRAG & DROP
// ==========================================
function handleDragStart(e) {
  e.dataTransfer.effectAllowed = "move";

  // Guardamos datos básicos
  const sourceData = {
    rank: e.target.dataset.rank,
    label: e.target.textContent,
    // Si viene del inventario, trae dataset.inventoryIndex; si viene del tablero no
    inventoryIndex: e.target.dataset.inventoryIndex,
    parentID: e.target.parentElement?.id // Para saber si viene del tablero o inventario
  };

  e.dataTransfer.setData("text/plain", JSON.stringify(sourceData));
  draggedSource = e.target;

  setTimeout(() => (e.target.style.opacity = "0.5"), 0);
}

function handleDragEnd(e) {
  e.target.style.opacity = "1";
  draggedSource = null;
  document.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
}

function enableDropZone(cell) {
  cell.addEventListener("dragover", (e) => {
    e.preventDefault(); // Necesario para permitir soltar
    e.dataTransfer.dropEffect = "move";
    cell.classList.add("drag-over");
  });

  cell.addEventListener("dragleave", () => {
    cell.classList.remove("drag-over");
  });

  cell.addEventListener("drop", (e) => {
    e.preventDefault();
    cell.classList.remove("drag-over");

    const data = JSON.parse(e.dataTransfer.getData("text/plain"));
    const targetCellId = cell.id;

    // CASO 1: Viene del Inventario -> Tablero
    if (!cell.hasChildNodes() && data.inventoryIndex !== undefined) {
      placePieceOnBoard(targetCellId, data.rank, data.label);
      removeFromInventory(Number(data.inventoryIndex));
      return;
    }

    // CASO 2: Movimiento dentro del tablero (Swap o Move)
    if (data.parentID && data.parentID.startsWith("cell-")) {
      const oldCell = document.getElementById(data.parentID);
      if (!oldCell) return;
      if (cell === oldCell) return; // Mismo lugar

      // Si la celda destino está vacía -> Mover
      if (!cell.hasChildNodes()) {
        oldCell.innerHTML = "";
        delete placedPieces[data.parentID];
        placePieceOnBoard(targetCellId, data.rank, data.label);
      }
      // Si está ocupada -> Intercambiar (SWAP)
      else {
        const targetPiece = cell.firstChild;
        const targetRank = targetPiece.dataset.rank;
        const targetLabel = targetPiece.textContent;

        // Poner la pieza arrastrada en destino
        cell.innerHTML = "";
        placePieceOnBoard(targetCellId, data.rank, data.label);

        // Poner la pieza destino en origen
        oldCell.innerHTML = "";
        placePieceOnBoard(data.parentID, targetRank, targetLabel);
      }
    }
  });
}

function placePieceOnBoard(cellId, rank, label) {
  const cell = document.getElementById(cellId);
  if (!cell) return;

  const piece = createPieceElement(rank, label);
  cell.appendChild(piece);

  // Guardar en estado lógico
  placedPieces[cellId] = { rank, label };
}

function removeFromInventory(index) {
  // Buscamos por rank del ítem en ese índice
  const rankToFind = inventoryState[index]?.rank;
  if (!rankToFind) return;

  const item = inventoryState.find((i) => i.rank === rankToFind);
  if (item && item.count > 0) {
    item.count--;
    renderInventory();
  }
}

// ==========================================
// 4. FUNCIONES DE BOTONES
// ==========================================

function resetBoardLogic() {
  if (!boardEl) return;

  boardEl.innerHTML = "";
  placedPieces = {};
  // Restaurar inventario original
  inventoryState = JSON.parse(JSON.stringify(ARMY_CONFIG));
  initBoard(); // Reconstruir grid vacío
}

// --- ALEATORIO ---
if (btnRandom) {
  btnRandom.addEventListener("click", () => {
    // 1. Limpiar tablero primero
    resetBoardLogic();

    // 2. Obtener todas las celdas válidas (filas 0-3)
    const validCells = [];
    for (let r = 0; r <= 3; r++) {
      for (let c = 0; c < 10; c++) {
        validCells.push(`cell-${r}-${c}`);
      }
    }

    // 3. Barajar celdas
    validCells.sort(() => Math.random() - 0.5);

    // 4. Colocar piezas restantes
    inventoryState.forEach((item) => {
      while (item.count > 0) {
        const cellId = validCells.pop();
        if (!cellId) break;

        placePieceOnBoard(cellId, item.rank, item.label);
        item.count--;
      }
    });

    renderInventory();
  });
}

// --- LIMPIAR ---
if (btnClear) {
  btnClear.addEventListener("click", resetBoardLogic);
}

// --- GRIMORIO (LocalStorage) ---
if (btnSave) {
  btnSave.addEventListener("click", () => {
    localStorage.setItem("stratego_setup", JSON.stringify(placedPieces));
    alert("📜 Grimorio guardado en el archivo local.");
  });
}

if (btnLoad) {
  btnLoad.addEventListener("click", () => {
    const saved = localStorage.getItem("stratego_setup");
    if (!saved) {
      alert("No tienes estrategias guardadas.");
      return;
    }

    resetBoardLogic();
    const savedData = JSON.parse(saved);

    // Colocar piezas y reducir inventario
    Object.keys(savedData).forEach((cellId) => {
      const p = savedData[cellId];
      placePieceOnBoard(cellId, p.rank, p.label);

      // Restar del inventario lógico
      const item = inventoryState.find((i) => i.rank === p.rank);
      if (item) item.count--;
    });

    renderInventory();
  });
}

// --- READY (HANDSHAKE) ---
if (btnReady) {
  btnReady.addEventListener("click", () => {
    const totalLeft = inventoryState.reduce((sum, item) => sum + item.count, 0);

    if (totalLeft > 0) {
      alert(`¡General! Aún tiene ${totalLeft} tropas sin asignar. Despliegue todas las unidades.`);
      return;
    }

    if (overlay) overlay.classList.remove("hidden");

    // Simulación: El enemigo tarda 3 segundos en estar listo
    setTimeout(() => {
      alert("¡El enemigo está listo! Inicia la batalla.");
      // Aquí iría la lógica para pasar a Etapa III
    }, 3000);
  });
}

// --- CHAT WAR ROOM (Simulado) ---
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

function escapeHtml(str) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// INICIAR (solo si existe el tablero en DOM)
if (boardEl) initBoard();
