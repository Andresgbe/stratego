import {
  gameState,
  pushLog,
  STRATEGO_ARMY_CONFIG,
  makeDefaultStrategoInventory,
  resetStrategoState,
} from "./gameState.js";
import { getActionById } from "./actions.js";
import { pickRandomEvent } from "./events.js";

// =========================================================
// 0) Pub/Sub — la UI se actualiza desde gameState
// =========================================================
const _listeners = new Set();

export function subscribe(fn) {
  _listeners.add(fn);
  // dispara una vez inicial
  try {
    fn(gameState);
  } catch {
    // ignore
  }
  return () => _listeners.delete(fn);
}

function notify() {
  _listeners.forEach((fn) => {
    try {
      fn(gameState);
    } catch {
      // ignore
    }
  });
}

// =========================================================
// 1) Helpers para mutaciones seguras (motor de acciones)
// =========================================================
const helpers = {
  addResources(player, delta) {
    player.recursos = Math.max(0, player.recursos + delta);
  },
  addMoral(player, delta) {
    player.moral = Math.max(0, Math.min(100, player.moral + delta));
  },
  addIntel(player, delta) {
    player.intel = Math.max(0, player.intel + delta);
  },
  addGlobalTension(delta) {
    gameState.global.tension = Math.max(
      0,
      Math.min(100, gameState.global.tension + delta)
    );
  },
  addGlobalIntel(delta) {
    gameState.global.intel = Math.max(
      0,
      Math.min(100, gameState.global.intel + delta)
    );
  },
};

export function getState() {
  return gameState;
}

export function setScreen(screen) {
  if (screen !== "lobby" && screen !== "warroom") return;
  gameState.screen = screen;
  notify();
}

export function canAct(playerId) {
  const p = gameState.jugadores.find((j) => j.id === playerId);
  if (!p || !p.vivo) return { ok: false, reason: "Jugador inválido o eliminado" };
  if (gameState.fase !== "accion") return { ok: false, reason: "No estamos en fase de acción" };
  if (p.estado.penalizacionTurnos > 0)
    return { ok: false, reason: "Jugador penalizado este turno" };
  return { ok: true };
}

export function avanzarFase() {
  if (gameState.fase === "planificacion") {
    gameState.fase = "accion";
    pushLog("system", "Cambio de fase → acción");
    notify();
    return;
  }

  if (gameState.fase === "accion") {
    gameState.fase = "resolucion";
    pushLog("system", "Cambio de fase → resolución");
    resolverTurno();
    notify();
    return;
  }

  // resolucion → nuevo turno
  gameState.fase = "planificacion";
  gameState.turno += 1;

  // tick penalizaciones
  gameState.jugadores.forEach((j) => {
    if (j.estado.penalizacionTurnos > 0) j.estado.penalizacionTurnos -= 1;
  });

  // regeneración simple de recursos por turno
  gameState.jugadores.forEach((j) => {
    if (j.vivo) helpers.addResources(j, 2);
  });

  pushLog("system", `Nuevo turno #${gameState.turno}`);
  notify();
}

export function ejecutarAccion({ playerId, actionId, targetId = null }) {
  const action = getActionById(actionId);
  if (!action) {
    pushLog("error", "Acción no existe", { actionId });
    notify();
    return { ok: false, reason: "Acción inválida" };
  }

  const p = gameState.jugadores.find((j) => j.id === playerId);
  if (!p) return { ok: false, reason: "Jugador inválido" };

  const can = canAct(playerId);
  if (!can.ok) return can;

  if (p.recursos < action.costo) {
    return { ok: false, reason: "No tienes recursos suficientes" };
  }

  // pagar costo
  helpers.addResources(p, -action.costo);

  // aplicar efecto (demo)
  if (actionId === "RECON") {
    helpers.addIntel(p, 2);
    helpers.addGlobalIntel(1);
  }

  if (actionId === "FORTIFY") {
    p.estado.protegido = true;
  }

  if (actionId === "PROPAGANDA") {
    helpers.addMoral(p, +8);
    helpers.addGlobalTension(+5);
  }

  if (actionId === "STRIKE") {
    helpers.addGlobalTension(+10);
    if (targetId) {
      const t = gameState.jugadores.find((j) => j.id === targetId);
      if (t && t.vivo) helpers.addMoral(t, -12);
    }
  }

  pushLog("action", `Acción ejecutada: ${action.nombre}`, {
    playerId,
    actionId,
    targetId,
  });

  notify();
  return { ok: true };
}

export function queueEvent(eventObj) {
  if (!eventObj) return;
  gameState.eventosActivos.push(eventObj);
  pushLog("event", `Evento en cola: ${eventObj.nombre}`, { id: eventObj.id });
  notify();
}

function resolverTurno() {
  // 1) genera un evento aleatorio (demo)
  const ev = pickRandomEvent(gameState);
  if (ev) queueEvent(ev);

  // 2) aplica eventos
  gameState.eventosActivos.forEach((e) => {
    e.apply(gameState, helpers);
    pushLog("event", `Evento resuelto: ${e.nombre}`, { id: e.id });
  });

  // 3) limpiar eventos
  gameState.eventosActivos = [];
}

// =========================================================
// 2) Stratego — Etapa III (despliegue/board) con autoridad del engine
// =========================================================

function cellId(r, c) {
  return `cell-${r}-${c}`;
}

function parseCellId(id) {
  const m = /^cell-(\d+)-(\d+)$/.exec(id);
  if (!m) return null;
  return { r: Number(m[1]), c: Number(m[2]) };
}

function isWater(r, c) {
  return (r === 4 || r === 5) && ((c === 2 || c === 3) || (c === 6 || c === 7));
}

function isDeployCell(playerId, r, c) {
  if (playerId === 1) return r >= 0 && r <= 3;
  if (playerId === 2) return r >= 6 && r <= 9;
  return false;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function strategoGetPhase() {
  return gameState.stratego.phase;
}

export function strategoSetPhase(phase) {
  const allowed = ["DEPLOYMENT", "HANDSHAKE", "BATTLE", "GAME_OVER"];
  if (!allowed.includes(phase)) return;
  gameState.stratego.phase = phase;
  if (phase !== "BATTLE") gameState.stratego.ui.selectedCell = null;
  notify();
}

export function strategoCountInventoryLeft(playerId = 1) {
  const inv = gameState.stratego.inventory[playerId] || {};
  return Object.values(inv).reduce((a, b) => a + (b || 0), 0);
}

export function strategoClearDeployment(playerId = 1) {
  // limpia piezas del jugador en tablero
  const board = gameState.stratego.board;
  for (const cid of Object.keys(board)) {
    if (board[cid]?.ownerId === playerId) delete board[cid];
  }

  // reinicia inventario del jugador
  gameState.stratego.inventory[playerId] = makeDefaultStrategoInventory();
  gameState.stratego.ready[playerId] = false;

  // si estabas en handshake, vuelve a deployment
  if (gameState.stratego.phase !== "DEPLOYMENT") {
    gameState.stratego.phase = "DEPLOYMENT";
  }

  notify();
}

export function strategoPlaceFromInventory({ playerId = 1, rank, targetCellId }) {
  if (gameState.stratego.phase !== "DEPLOYMENT") {
    return { ok: false, reason: "No estás en fase de despliegue" };
  }

  const pos = parseCellId(targetCellId);
  if (!pos) return { ok: false, reason: "Celda inválida" };
  if (isWater(pos.r, pos.c)) return { ok: false, reason: "No puedes colocar en el lago" };
  if (!isDeployCell(playerId, pos.r, pos.c))
    return { ok: false, reason: "Fuera de tu zona de despliegue" };

  if (gameState.stratego.board[targetCellId])
    return { ok: false, reason: "Celda ocupada" };

  const inv = gameState.stratego.inventory[playerId] || {};
  const left = inv[rank] || 0;
  if (left <= 0) return { ok: false, reason: "No quedan unidades de ese tipo" };

  inv[rank] = left - 1;
  gameState.stratego.inventory[playerId] = inv;
  gameState.stratego.board[targetCellId] = { ownerId: playerId, rank };

  notify();
  return { ok: true };
}

export function strategoMoveOrSwapDeployment({ playerId = 1, fromCellId, toCellId }) {
  if (gameState.stratego.phase !== "DEPLOYMENT") {
    return { ok: false, reason: "No estás en fase de despliegue" };
  }

  const from = parseCellId(fromCellId);
  const to = parseCellId(toCellId);
  if (!from || !to) return { ok: false, reason: "Celda inválida" };
  if (isWater(to.r, to.c)) return { ok: false, reason: "No puedes mover al lago" };

  // solo dentro de tu zona
  if (!isDeployCell(playerId, from.r, from.c))
    return { ok: false, reason: "Origen fuera de tu zona" };
  if (!isDeployCell(playerId, to.r, to.c))
    return { ok: false, reason: "Destino fuera de tu zona" };

  const board = gameState.stratego.board;
  const moving = board[fromCellId];
  if (!moving) return { ok: false, reason: "No hay pieza en el origen" };
  if (moving.ownerId !== playerId)
    return { ok: false, reason: "Solo puedes mover tus piezas" };

  const target = board[toCellId];

  // mover
  if (!target) {
    delete board[fromCellId];
    board[toCellId] = moving;
    notify();
    return { ok: true };
  }

  // swap (solo con pieza propia)
  if (target.ownerId !== playerId)
    return { ok: false, reason: "No puedes intercambiar con pieza enemiga" };

  board[toCellId] = moving;
  board[fromCellId] = target;

  notify();
  return { ok: true };
}

export function strategoRandomizeDeployment(playerId = 1) {
  if (gameState.stratego.phase !== "DEPLOYMENT") return { ok: false, reason: "No estás en despliegue" };

  // limpia piezas propias + inventario full
  strategoClearDeployment(playerId);

  // genera celdas válidas
  const cells = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (isWater(r, c)) continue;
      if (isDeployCell(playerId, r, c)) cells.push(cellId(r, c));
    }
  }

  const pool = shuffle(cells);
  const inv = gameState.stratego.inventory[playerId];

  for (const def of STRATEGO_ARMY_CONFIG) {
    while ((inv[def.rank] || 0) > 0) {
      const cid = pool.pop();
      if (!cid) break;
      inv[def.rank] = (inv[def.rank] || 0) - 1;
      gameState.stratego.board[cid] = { ownerId: playerId, rank: def.rank };
    }
  }

  notify();
  return { ok: true };
}

export function strategoExportDeployment(playerId = 1) {
  const out = {};
  for (const [cid, piece] of Object.entries(gameState.stratego.board)) {
    if (piece?.ownerId === playerId) out[cid] = { rank: piece.rank };
  }
  return out;
}

export function strategoImportDeployment(playerId = 1, data = {}) {
  if (gameState.stratego.phase !== "DEPLOYMENT") {
    return { ok: false, reason: "Solo puedes cargar en despliegue" };
  }

  const board = gameState.stratego.board;
  for (const cid of Object.keys(board)) {
    if (board[cid]?.ownerId === playerId) delete board[cid];
  }

  gameState.stratego.inventory[playerId] = makeDefaultStrategoInventory();
  gameState.stratego.ready[playerId] = false;

  for (const [cid, obj] of Object.entries(data || {})) {
    const rank = obj?.rank;
    if (!rank) continue;

    const pos = parseCellId(cid);
    if (!pos) continue;
    if (isWater(pos.r, pos.c)) continue;
    if (!isDeployCell(playerId, pos.r, pos.c)) continue;
    if (board[cid]) continue;

    const inv = gameState.stratego.inventory[playerId];
    if ((inv[rank] || 0) <= 0) continue;

    inv[rank] -= 1;
    board[cid] = { ownerId: playerId, rank };
  }

  notify();
  return { ok: true };
}

let _handshakeTimer = null;

export function strategoSetReady(playerId = 1, { autoEnemy = true } = {}) {
  if (gameState.stratego.phase !== "DEPLOYMENT") {
    return { ok: false, reason: "Solo puedes dar listo en despliegue" };
  }

  const left = strategoCountInventoryLeft(playerId);
  if (left > 0) {
    return { ok: false, reason: `Aún tienes ${left} tropas sin asignar` };
  }

  gameState.stratego.ready[playerId] = true;

  // PvE demo: auto despliega enemigo
  if (autoEnemy) {
    const enemyId = playerId === 1 ? 2 : 1;
    if (!gameState.stratego.ready[enemyId]) {
      if (!gameState.stratego.inventory[enemyId]) {
        gameState.stratego.inventory[enemyId] = makeDefaultStrategoInventory();
      }
      const prevPhase = gameState.stratego.phase;
      gameState.stratego.phase = "DEPLOYMENT";
      strategoRandomizeDeployment(enemyId);
      gameState.stratego.phase = prevPhase;
      gameState.stratego.ready[enemyId] = true;
    }
  }

  gameState.stratego.phase = "HANDSHAKE";
  pushLog("system", "Formación bloqueada: handshake iniciado", { playerId });

  if (_handshakeTimer) {
    clearTimeout(_handshakeTimer);
    _handshakeTimer = null;
  }

  _handshakeTimer = setTimeout(() => {
    if (gameState.stratego.phase !== "HANDSHAKE") return;
    gameState.stratego.phase = "BATTLE";
    pushLog("system", "¡Batalla iniciada!", {});
    notify();
  }, 3000);

  notify();
  return { ok: true };
}

export function strategoResetAll({ playerIds = [1, 2] } = {}) {
  resetStrategoState({ playerIds });
  notify();
}
